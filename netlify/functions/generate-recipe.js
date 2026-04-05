// Netlify Function: Proxy per Claude API - Generazione Ricette Personalizzate
// La ANTHROPIC_API_KEY è impostata come env var su Netlify

const buildSystemPrompt = (dietPlans, cookingMethods) => {
    // Genera regole dietetiche dinamicamente dai piani configurati
    const allCategories = [];
    const typeLabels = {};
    if (dietPlans && dietPlans.length > 0) {
        dietPlans.forEach(plan => {
            if (!plan.isFreeTrack && plan.categories) {
                plan.categories.forEach(cat => {
                    allCategories.push({ plan: plan.name, id: cat.id, label: cat.label, guideline: cat.guideline });
                    typeLabels[cat.id] = cat.label;
                });
            }
        });
    }

    const guidelinesText = allCategories.length > 0
        ? allCategories.map(c => `- Tipo "${c.id}" (${c.label}, piano ${c.plan}): ${c.guideline}`).join('\n')
        : `- Tipo "1" (Pasta/Riso): 90g pasta + 60g pesce/ragu + 200g verdure\n- Tipo "2" (Carne): 200g carne + 200g verdure + 40g riso / 60g pane\n- Tipo "3" (Legumi): 70g cereali + 40g legumi + 200g verdure\n- Tipo "4" (Pesce): 200g pesce + 200g verdure + 40g riso / 60g pane`;

    const typesText = allCategories.length > 0
        ? [...new Set(allCategories.map(c => `"${c.id}" (${c.label})`))].join(', ') + ', "F" (Famiglia)'
        : '"1" (Pasta/Riso), "2" (Carne), "3" (Legumi/Cereali), "4" (Pesce), "F" (Famiglia)';

    let prompt = `Sei un nutrizionista italiano esperto di cucina mediterranea, specializzato in pianificazione pasti per famiglie.
Il tuo obiettivo è creare ricette PRATICHE, VELOCI e BILANCIATE che si adattino alla vita reale di una famiglia impegnata.

REGOLE DIETETICHE (grammature per porzione singola):
${guidelinesText}

TIPI: ${typesText}
UNITÀ: "g", "ml", "pz", "qb"`;

    if (dietPlans && dietPlans.length > 0) {
        prompt += `\n\nPIANI ALIMENTARI CONFIGURATI:`;
        dietPlans.forEach(plan => {
            if (plan.isFreeTrack) {
                prompt += `\n- "${plan.name}": piano libero, nessun vincolo dietetico`;
            } else {
                const cats = plan.categories.map(c => `${c.label} (${c.target}x/sett)`).join(', ');
                prompt += `\n- "${plan.name}": ${cats}`;
                if (plan.conflicts && plan.conflicts.length > 0) {
                    const conflictStrs = plan.conflicts.map(conf => {
                        const [a, b] = conf.split(':');
                        const la = plan.categories.find(c => c.id === a)?.label || a;
                        const lb = plan.categories.find(c => c.id === b)?.label || b;
                        return `${la} + ${lb}`;
                    });
                    prompt += ` | Conflitti: non ${conflictStrs.join(', ')} nello stesso giorno`;
                }
            }
        });
    }

    if (cookingMethods && cookingMethods.length > 0) {
        prompt += `\n\nMETODI DI COTTURA PREFERITI: ${cookingMethods.join(', ')}. Usa principalmente questi metodi di cottura.`;
    }

    prompt += `

PRINCIPI PER FAMIGLIE:
1. Privilegia ricette che piacciono anche ai bambini
2. Suggerisci piatti che si possono preparare in anticipo quando possibile
3. Favorisci ingredienti che si riusano tra più ricette della settimana (ottimizza la spesa)
4. Le ricette devono essere realistiche per una cucina casalinga

FORMATO OUTPUT (rispondi SOLO con JSON valido):
{
  "recipes": [
    {
      "type": "1",
      "name": "Nome Ricetta",
      "prepTime": 25,
      "tip": "Consiglio pratico breve",
      "ingredients": [
        { "name": "Ingrediente", "qty": 90, "unit": "g" }
      ]
    }
  ]
}`;

    return prompt;
};

exports.handler = async (event) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Solo POST ammesso' }) };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return {
            statusCode: 500, headers,
            body: JSON.stringify({ error: 'ANTHROPIC_API_KEY non configurata. Aggiungila nelle Environment Variables di Netlify.' })
        };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body JSON non valido' }) };
    }

    const { mode } = body;

    // ==================== MODO: PARSE RECEIPT ====================
    if (mode === 'parse_receipt') {
        const { images, existingPantry } = body;

        if (!images || images.length === 0) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nessuna immagine fornita' }) };
        }

        const pantryList = (existingPantry || []).map(p => `${p.name} (${p.qty}${p.unit}, ${p.container})`).join(', ');

        const systemPrompt = `Sei un assistente specializzato nell'analisi di scontrini della spesa italiana.
Il tuo compito è estrarre i prodotti alimentari dallo scontrino e normalizzarli.

REGOLE:
1. NORMALIZZA i nomi: rimuovi marche, codici, abbreviazioni. Es: "MOZZ. S.LUCIA 125G" → "Mozzarella"
2. DEDUCI le quantità nette dal testo quando possibile (125G → qty: 125, unit: "g")
3. Se la quantità non è chiara, usa un valore tipico (es: 1 pacco di pasta = 500g, 1 bottiglia latte = 1000ml)
4. Per prodotti venduti a pezzi (es: 6 uova, 1 insalata), usa unit: "pz"
5. SUGGERISCI il contenitore appropriato:
   - "frigo": latticini, carne fresca, salumi, pesce fresco, verdure fresche, uova
   - "freezer": surgelati, gelati, prodotti congelati
   - "dispensa": pasta, riso, conserve, olio, farina, biscotti, bevande
6. SUGGERISCI la categoria: "Verdura", "Carne", "Pesce", "Latticini", "Cereali e Pasta", "Legumi", "Dispensa", "Altro"
7. IGNORA prodotti non alimentari (detersivi, carta, ecc.)
8. Mantieni il testo originale in "rawText" per riferimento

${pantryList ? `PRODOTTI GIA IN DISPENSA: ${pantryList}\nSe un prodotto dello scontrino corrisponde a uno già in dispensa, segnalalo in "existingMatch" con il nome.` : ''}

FORMATO OUTPUT (rispondi SOLO con JSON valido):
{
  "products": [
    { "name": "Mozzarella", "qty": 125, "unit": "g", "container": "frigo", "category": "Latticini", "rawText": "MOZZ. S.LUCIA 125G", "existingMatch": null }
  ]
}`;

        // Build content blocks with images
        const contentBlocks = [];
        for (const img of images) {
            // Extract base64 data and media type from data URL
            const match = img.match(/^data:(image\/[a-z]+);base64,(.+)$/i);
            if (match) {
                contentBlocks.push({
                    type: 'image',
                    source: { type: 'base64', media_type: match[1], data: match[2] }
                });
            }
        }
        contentBlocks.push({ type: 'text', text: 'Analizza questo scontrino ed estrai i prodotti alimentari.' });

        try {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 4096,
                    system: systemPrompt,
                    messages: [{ role: 'user', content: contentBlocks }]
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error('Claude API error (receipt):', response.status, errText);
                if (response.status === 429) {
                    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Troppe richieste. Riprova tra qualche secondo.' }) };
                }
                return { statusCode: 502, headers, body: JSON.stringify({ error: 'Errore nella comunicazione con Claude API' }) };
            }

            const data = await response.json();
            const content = data.content[0].text;

            let jsonStr = content;
            const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) jsonStr = jsonMatch[1];

            const parsed = JSON.parse(jsonStr.trim());

            const validProducts = (parsed.products || []).map(p => ({
                name: String(p.name || ''),
                qty: Number(p.qty) || 1,
                unit: ['g', 'ml', 'pz'].includes(p.unit) ? p.unit : 'pz',
                container: ['dispensa', 'frigo', 'freezer'].includes(p.container) ? p.container : 'dispensa',
                category: p.category || 'Altro',
                rawText: p.rawText || '',
                existingMatch: p.existingMatch || null
            })).filter(p => p.name.length > 0);

            return {
                statusCode: 200, headers,
                body: JSON.stringify({ products: validProducts })
            };

        } catch (err) {
            console.error('Function error (parse_receipt):', err);
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Errore interno nella scansione dello scontrino' }) };
        }
    }

    // ==================== MODO: WEEKLY PLAN ====================
    if (mode === 'weekly_plan') {
        const { pantry: pantryData, fridgeIngredients, recipes: recipeList, dietPlans, cookingMethods, context } = body;

        if (!recipeList || recipeList.length === 0) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nessuna ricetta nel database. Aggiungi delle ricette prima di generare un piano.' }) };
        }

        const systemPrompt = buildSystemPrompt(dietPlans, cookingMethods);

        // Build recipe catalog for AI
        const recipeCatalog = recipeList.map(r => {
            const ings = r.ingredients.map(i => i.name).join(', ');
            return `ID:${r.id} | Tipo:${r.type} | "${r.name}" | Ingredienti: ${ings}`;
        }).join('\n');

        // Build diet plan track info
        let tracksInfo = '';
        if (dietPlans && dietPlans.length > 0) {
            tracksInfo = dietPlans.map(dp => {
                if (dp.isFreeTrack) return `- Track "${dp.id}" ("${dp.name}"): piano libero, usa tipo "F", portions: 2`;
                const totalTarget = dp.categories.reduce((sum, c) => sum + c.target, 0);
                const liberoSlots = 14 - totalTarget;
                const cats = dp.categories.map(c => `${c.label}(tipo "${c.id}") ESATTAMENTE ${c.target}x/settimana`).join(', ');
                const conflictText = dp.conflicts && dp.conflicts.length > 0
                    ? dp.conflicts.map(conf => {
                        const [a, b] = conf.split(':');
                        const la = dp.categories.find(c => c.id === a)?.label || a;
                        const lb = dp.categories.find(c => c.id === b)?.label || b;
                        return `${la}(${a}) e ${lb}(${b}) NON possono essere nello stesso giorno (pranzo+cena)`;
                    }).join('; ')
                    : 'nessuno';
                return `- Track "${dp.id}" ("${dp.name}"): ${cats}. I restanti ${liberoSlots} slot DEVONO avere type "LIBERO" (pasto senza vincolo dietetico, scegli comunque una ricetta adatta). Conflitti giornalieri: ${conflictText}. portions: 1`;
            }).join('\n');
        }

        // Build pantry note (new system) or fallback to old fridgeIngredients
        let pantryNote = '';
        if (pantryData && pantryData.length > 0) {
            const byContainer = { frigo: [], freezer: [], dispensa: [] };
            pantryData.forEach(p => {
                const c = p.container || 'dispensa';
                if (byContainer[c]) byContainer[c].push(`${p.name} ${p.qty}${p.unit}`);
            });
            pantryNote = '\nDISPENSA ATTUALE:';
            if (byContainer.frigo.length > 0) pantryNote += `\n[Frigo] ${byContainer.frigo.join(', ')}`;
            if (byContainer.freezer.length > 0) pantryNote += `\n[Freezer] ${byContainer.freezer.join(', ')}`;
            if (byContainer.dispensa.length > 0) pantryNote += `\n[Dispensa] ${byContainer.dispensa.join(', ')}`;
            pantryNote += `\n\nISTRUZIONI DISPENSA: Dai PRIORITA ai prodotti del FRIGO (deperibili) nei primi giorni. I prodotti del FREEZER sono congelati. La DISPENSA contiene prodotti a lunga conservazione. Scegli ricette che utilizzino questi ingredienti per ridurre la spesa.`;
        } else if (fridgeIngredients && fridgeIngredients.trim()) {
            // Legacy fallback
            pantryNote = `\nINGREDIENTI IN FRIGO DA SMALTIRE: ${fridgeIngredients}\nUSA QUESTI INGREDIENTI nei primi 2-3 giorni della settimana.`;
        }

        const contextNote = context ? `\nNote aggiuntive: ${context}` : '';

        const userPrompt = `Genera un piano pasti settimanale completo usando SOLO le ricette dal catalogo sotto.

CATALOGO RICETTE DISPONIBILI:
${recipeCatalog}

TRACKS (piani alimentari) da compilare per ogni pasto:
${tracksInfo}
${pantryNote}${contextNote}

REGOLE:
1. Assegna una ricetta a OGNI slot (7 giorni x pranzo e cena = 14 slot)
2. Per ogni slot, compila TUTTE le tracks elencate sopra
3. Non ripetere la stessa ricetta più di 2 volte nella settimana
4. I target per categoria sono ESATTI: assegna il numero PRECISO di pasti per ogni categoria. Quando tutti i target sono raggiunti, gli slot rimanenti DEVONO avere type "LIBERO" (pasto libero senza vincolo dietetico)
5. CONFLITTI GIORNALIERI: se due tipi sono in conflitto (indicato sopra), NON assegnarli nello stesso giorno (uno a pranzo e l'altro a cena)
6. Usa SOLO gli ID delle ricette dal catalogo
7. Per le track libere (isFreeTrack), assegna type "F" e scegli ricette adatte alla famiglia
8. Per gli slot "LIBERO" delle track dieta, scegli comunque una ricetta dal catalogo (qualsiasi tipo)

GIORNI: Lunedi, Martedi, Mercoledi, Giovedi, Venerdi, Sabato, Domenica
PASTI: Pranzo, Cena

FORMATO OUTPUT (rispondi SOLO con JSON valido):
{
  "weeklyPlan": [
    { "day": "Lunedi", "meal": "Pranzo", "tracks": { "track_id": { "type": "2", "recipeId": 123, "portions": 1 } } },
    { "day": "Lunedi", "meal": "Cena", "tracks": { "track_id": { "type": "3", "recipeId": 456, "portions": 1 } } }
  ]
}`;

        try {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 4096,
                    system: systemPrompt,
                    messages: [{ role: 'user', content: userPrompt }]
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error('Claude API error:', response.status, errText);
                if (response.status === 429) {
                    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Troppe richieste. Riprova tra qualche secondo.' }) };
                }
                return { statusCode: 502, headers, body: JSON.stringify({ error: 'Errore nella comunicazione con Claude API' }) };
            }

            const data = await response.json();
            const content = data.content[0].text;

            let jsonStr = content;
            const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) jsonStr = jsonMatch[1];

            const parsed = JSON.parse(jsonStr.trim());

            if (!parsed.weeklyPlan || !Array.isArray(parsed.weeklyPlan)) {
                return { statusCode: 502, headers, body: JSON.stringify({ error: 'Risposta AI non nel formato atteso per il piano settimanale' }) };
            }

            // Validate recipe IDs exist
            const validIds = new Set(recipeList.map(r => r.id));
            const validPlan = parsed.weeklyPlan.map(entry => {
                const tracks = {};
                if (entry.tracks) {
                    Object.entries(entry.tracks).forEach(([trackId, track]) => {
                        const rid = Number(track.recipeId);
                        tracks[trackId] = {
                            type: String(track.type || ''),
                            recipeId: validIds.has(rid) ? rid : null,
                            portions: Number(track.portions) || 1
                        };
                    });
                }
                return { day: String(entry.day), meal: String(entry.meal), tracks };
            });

            return {
                statusCode: 200, headers,
                body: JSON.stringify({
                    weeklyPlan: validPlan
                })
            };

        } catch (err) {
            console.error('Function error (weekly_plan):', err);
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Errore interno nella generazione del piano settimanale' }) };
        }
    }

    // ==================== MODO: FROM INGREDIENTS (default) ====================
    const { ingredients, dietPlans, targetPlan, cookingMethods, context } = body;
    const systemPrompt = buildSystemPrompt(dietPlans, cookingMethods);

    if (!ingredients || ingredients.trim().length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Inserisci almeno un ingrediente' }) };
    }

    const contextNote = context ? `\nContesto di oggi: ${context}` : '';
    const typeHint = body.recipeType ? `\nTipo ricetta richiesto: ${body.recipeType} (rispetta le grammature per questo tipo)` : '';
    const timeHint = body.maxTime ? `\nTempo massimo di preparazione: ${body.maxTime} minuti` : '';

    let planHint = '';
    if (targetPlan) {
        if (targetPlan.isFreeTrack) {
            planHint = `\nQuesta ricetta è per il piano "${targetPlan.name}" (piano libero, senza vincoli dietetici). Usa tipo "F". Crea ricette gustose e pratiche per tutta la famiglia, senza vincoli di grammature.`;
        } else if (targetPlan.categories) {
            const cats = targetPlan.categories.map(c => `tipo "${c.id}" (${c.label}): ${c.guideline}`).join('\n  - ');
            planHint = `\nQuesta ricetta è per il piano "${targetPlan.name}". Deve rispettare una di queste categorie:\n  - ${cats}\nAssegna il tipo corretto in base agli ingredienti e alle grammature.`;
        }
    }

    const userPrompt = `Ho questi ingredienti disponibili: ${ingredients}
${typeHint}${timeHint}${planHint}${contextNote}
Genera 2-3 ricette usando principalmente questi ingredienti. Puoi aggiungere solo condimenti base (olio, sale, spezie) se mancano. Ogni ricetta deve avere un tipo (1-4 o F) e rispettare le grammature dietetiche.
Includi un "tip" pratico per ogni ricetta (es. "si può preparare la sera prima", "i bambini lo adorano con un filo di parmigiano").`;

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4096,
                system: systemPrompt,
                messages: [{ role: 'user', content: userPrompt }]
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('Claude API error:', response.status, errText);
            if (response.status === 429) {
                return { statusCode: 429, headers, body: JSON.stringify({ error: 'Troppe richieste. Riprova tra qualche secondo.' }) };
            }
            return { statusCode: 502, headers, body: JSON.stringify({ error: 'Errore nella comunicazione con Claude API' }) };
        }

        const data = await response.json();
        const content = data.content[0].text;

        let jsonStr = content;
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) jsonStr = jsonMatch[1];

        const parsed = JSON.parse(jsonStr.trim());

        if (!parsed.recipes || !Array.isArray(parsed.recipes)) {
            return { statusCode: 502, headers, body: JSON.stringify({ error: 'Risposta AI non nel formato atteso' }) };
        }

        const validRecipes = parsed.recipes.filter(r =>
            r.name && r.type && Array.isArray(r.ingredients) && r.ingredients.length > 0
        ).map(r => ({
            type: String(r.type),
            name: String(r.name),
            prepTime: Number(r.prepTime) || null,
            tip: r.tip ? String(r.tip) : null,
            ingredients: r.ingredients.map(ing => ({
                name: String(ing.name),
                qty: Number(ing.qty) || 0,
                unit: ['g', 'ml', 'pz', 'qb'].includes(ing.unit) ? ing.unit : 'g'
            }))
        }));

        return {
            statusCode: 200, headers,
            body: JSON.stringify({ recipes: validRecipes })
        };

    } catch (err) {
        console.error('Function error:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Errore interno nella generazione ricette' }) };
    }
};
