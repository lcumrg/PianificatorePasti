# Pianificatore Pasti

Applicazione web per la pianificazione settimanale dei pasti, con gestione ricette e lista della spesa automatica.

## Funzionalità

- **Planner settimanale** — Organizza pranzo e cena per ogni giorno della settimana con selezione del tipo di pasto (pasta, carne, legumi, pesce)
- **Database ricette** — Gestisci le tue ricette con ingredienti e porzioni, con supporto import/export CSV
- **Lista della spesa** — Generata automaticamente dalle ricette selezionate nel planner
- **Validazione dieta** — Controllo della distribuzione dei tipi di pasto nella settimana
- **Sincronizzazione cloud** — Salvataggio automatico su Firebase Firestore
- **Stampa menu** — Esporta il menu settimanale in formato stampabile

## Tech Stack

- React 18 (CDN)
- Tailwind CSS
- Firebase Firestore
- Babel (transpilazione JSX nel browser)

## Deploy

Il sito è pubblicato su [Netlify](https://pianificatorepasti.netlify.app) con deploy automatico da GitHub.

Ogni push su `main` triggera automaticamente un nuovo deploy.
