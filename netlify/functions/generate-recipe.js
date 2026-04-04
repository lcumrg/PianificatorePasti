// Netlify Function: Proxy per Claude API - Generazione Ricette Personalizzate
// La ANTHROPIC_API_KEY è impostata come env var su Netlify

const DIET_GUIDELINES = {
    '1': "90g pasta/orzo/riso + 60g pesce o ragù o pesto + 200g verdure",
    '2': "200g carne + 200g verdure + 40g riso / 60g pane",
    '3': "70g cereali (orzo/riso integrale/farro/avena) + 40g legumi + 200g verdure",
    '4': "200g salmone / 250g pesce + 200g verdure + 40g riso / 60g pane"
};

const buildSystemPrompt = (familyPrefs) => {
    let prompt = `Sei un nutrizionista italiano esperto di cucina mediterranea, specializzato in pianificazione pasti per famiglie.
Il tuo obiettivo è creare ricette PRATICHE, VELOCI e BILANCIATE che si adattino alla vita reale di una famiglia impegnata.

REGOLE DIETETICHE (grammature per porzione singola):
${Object.entries(DIET_GUIDELINES).map(([k, v]) => `- Tipo ${k}: ${v}`).join('\n')}

TIPI: "1" (Pasta/Riso), "2" (Carne), "3" (Legumi/Cereali), "4" (Pesce), "F" (Famiglia)
UNITÀ: "g", "ml", "pz", "qb"`;

    if (familyPrefs) {
        prompt += `\n\nPROFILO FAMIGLIA:`;
        if (familyPrefs.familySize) prompt += `\n- Componenti: ${familyPrefs.familySize} persone`;
        if (familyPrefs.restrictions) prompt += `\n- Restrizioni/allergie: ${familyPrefs.restrictions}`;
        if (familyPrefs.kidsPrefs) prompt += `\n- Preferenze bambini: ${familyPrefs.kidsPrefs}`;
        if (familyPrefs.maxPrepTime) prompt += `\n- Tempo preparazione preferito: max ${familyPrefs.maxPrepTime} minuti`;
        if (familyPrefs.cuisinePrefs) prompt += `\n- Preferenze cucina: ${familyPrefs.cuisinePrefs}`;
        if (familyPrefs.notes) prompt += `\n- Note: ${familyPrefs.notes}`;
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

    const { mode, ingredients, planSlots, existingRecipeNames, familyPrefs, context } = body;
    const systemPrompt = buildSystemPrompt(familyPrefs);

    let userPrompt;
    const contextNote = context ? `\nContesto di oggi: ${context}` : '';

    if (mode === 'from_ingredients') {
        if (!ingredients || ingredients.trim().length === 0) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Inserisci almeno un ingrediente' }) };
        }
        const typeHint = body.recipeType ? `\nTipo ricetta richiesto: ${body.recipeType} (rispetta le grammature per questo tipo)` : '';
        const timeHint = body.maxTime ? `\nTempo massimo di preparazione: ${body.maxTime} minuti` : '';
        userPrompt = `Ho questi ingredienti disponibili: ${ingredients}
${typeHint}${timeHint}${contextNote}
Genera 2-3 ricette usando principalmente questi ingredienti. Puoi aggiungere solo condimenti base (olio, sale, spezie) se mancano. Ogni ricetta deve avere un tipo (1-4 o F) e rispettare le grammature dietetiche.
Includi un "tip" pratico per ogni ricetta (es. "si può preparare la sera prima", "i bambini lo adorano con un filo di parmigiano").`;

    } else if (mode === 'from_plan') {
        if (!planSlots || planSlots.length === 0) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nessuno slot vuoto nel piano' }) };
        }
        const existing = existingRecipeNames ? `\nRicette già nel database (evita duplicati): ${existingRecipeNames.join(', ')}` : '';
        const slotsDesc = planSlots.map(s => `- ${s.day} ${s.meal}: tipo ${s.type}`).join('\n');
        userPrompt = `Devo completare il piano settimanale. Genera UNA ricetta per ciascuno di questi slot vuoti:
${slotsDesc}
${existing}${contextNote}
IMPORTANTE:
- Genera ricette VARIE tra loro (non ripetere proteine o contorni uguali)
- Ottimizza gli ingredienti: favorisci ingredienti che si riusano tra più ricette (es. se usi zucchine lunedì, suggeriscile anche mercoledì)
- Alterna cotture diverse (forno, padella, bollitura, crudo)
- Includi un "tip" pratico per ogni ricetta`;

    } else {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Mode non valido. Usa "from_ingredients" o "from_plan"' }) };
    }

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
