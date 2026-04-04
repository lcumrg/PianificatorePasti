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
