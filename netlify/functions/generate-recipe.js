// Netlify Function: Proxy per Claude API - Generazione Ricette
// La ANTHROPIC_API_KEY è impostata come env var su Netlify

const DIET_GUIDELINES = {
    '1': "90g pasta/orzo/riso + 60g pesce o ragù o pesto + 200g verdure",
    '2': "200g carne + 200g verdure + 40g riso / 60g pane",
    '3': "70g cereali (orzo/riso integrale/farro/avena) + 40g legumi + 200g verdure",
    '4': "200g salmone / 250g pesce + 200g verdure + 40g riso / 60g pane"
};

const SYSTEM_PROMPT = `Sei un nutrizionista italiano esperto di cucina mediterranea. Generi ricette strutturate in formato JSON.

REGOLE FONDAMENTALI:
1. Le ricette DEVONO rispettare le grammature dietetiche per tipo:
${Object.entries(DIET_GUIDELINES).map(([k, v]) => `   - Tipo ${k}: ${v}`).join('\n')}
2. I tipi disponibili sono: "1" (Pasta/Riso), "2" (Carne), "3" (Legumi/Cereali), "4" (Pesce), "F" (Famiglia)
3. Le unità ammesse sono: "g", "ml", "pz", "qb"
4. I nomi delle ricette devono essere in italiano, descrittivi ma concisi
5. Gli ingredienti devono essere realistici e acquistabili in un supermercato italiano
6. Le quantità sono PER PORZIONE SINGOLA
7. Rispondi SOLO con JSON valido, senza testo aggiuntivo

FORMATO OUTPUT:
{
  "recipes": [
    {
      "type": "1",
      "name": "Nome Ricetta",
      "ingredients": [
        { "name": "Ingrediente", "qty": 90, "unit": "g" }
      ]
    }
  ]
}`;

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

    const { mode, ingredients, planSlots, existingRecipeNames } = body;

    let userPrompt;

    if (mode === 'from_ingredients') {
        if (!ingredients || ingredients.trim().length === 0) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Inserisci almeno un ingrediente' }) };
        }
        const typeHint = body.recipeType ? `\nTipo ricetta richiesto: ${body.recipeType} (rispetta le grammature per questo tipo)` : '';
        userPrompt = `Ho questi ingredienti disponibili: ${ingredients}
${typeHint}
Genera 2-3 ricette usando principalmente questi ingredienti. Puoi aggiungere solo condimenti base (olio, sale, spezie) se mancano. Ogni ricetta deve avere un tipo (1-4 o F) e rispettare le grammature dietetiche per quel tipo.`;

    } else if (mode === 'from_plan') {
        if (!planSlots || planSlots.length === 0) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nessuno slot vuoto nel piano' }) };
        }
        const existing = existingRecipeNames ? `\nRicette già nel database (evita duplicati): ${existingRecipeNames.join(', ')}` : '';
        const slotsDesc = planSlots.map(s => `- ${s.day} ${s.meal}: tipo ${s.type}`).join('\n');
        userPrompt = `Devo completare il piano settimanale. Genera UNA ricetta per ciascuno di questi slot vuoti:
${slotsDesc}
${existing}
Per ogni slot, genera una ricetta del tipo indicato rispettando le grammature dietetiche. Le ricette devono essere varie tra loro.`;

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
                max_tokens: 2048,
                system: SYSTEM_PROMPT,
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

        // Estrai JSON dalla risposta (potrebbe essere wrappato in markdown code block)
        let jsonStr = content;
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) jsonStr = jsonMatch[1];

        const parsed = JSON.parse(jsonStr.trim());

        if (!parsed.recipes || !Array.isArray(parsed.recipes)) {
            return { statusCode: 502, headers, body: JSON.stringify({ error: 'Risposta AI non nel formato atteso' }) };
        }

        // Validazione e pulizia ricette
        const validRecipes = parsed.recipes.filter(r =>
            r.name && r.type && Array.isArray(r.ingredients) && r.ingredients.length > 0
        ).map(r => ({
            type: String(r.type),
            name: String(r.name),
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
