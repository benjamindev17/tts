Présentation
Picka est une web app de type "Doodle" pensée pour être simple, rapide et mobile-first. Elle permet de créer un sondage de disponibilités, de le partager par lien et de voir les résultats se mettre à jour en temps réel.
Pas de compte à créer. Pas d'email. On arrive, on vote, c'est fait.

Fonctionnalités

Créer un sondage — titre + sélection des dates sur un calendrier
Partager par lien — URL unique directement ouvrable par n'importe qui
Voter — 3 états par date : Disponible · Peut-être · Indisponible
Résultats en temps réel — mis à jour instantanément via Firestore onSnapshot
Modifier son vote — possible à tout moment
Meilleure date mise en évidence — visualisation claire du résultat
Supprimer un sondage — réservé au créateur, avec confirmation
Installable — PWA complète, ajout à l'écran d'accueil iOS & Android


Stack technique
CoucheTechnologieFrontendHTML · CSS · Vanilla JS (ES Modules)StyleTailwind CSS (CDN) · Inter (Google Fonts)Base de donnéesFirebase FirestoreHébergementGitHub PagesPWAWeb App Manifest · apple-touch-icon
Pas de framework, pas de bundler — le projet tient en 4 fichiers.

Structure du projet
picka/
├── index.html        # Entrée de l'app
├── app.js            # Logique complète (state, vues, Firebase)
├── style.css         # Styles globaux et animations
├── favicon.svg       # Icône SVG
├── manifest.json     # Manifest PWA
└── apple-touch-icon.png

Architecture
L'app est un SPA (Single Page Application) sans framework, rendu côté client avec un pattern state → render :
state (objet JS)
    │
    ▼
render() → innerHTML
    │
    ▼
attachEvents() → listeners
Les vues sont des fonctions qui retournent du HTML (renderWelcome, renderDashboard, renderCreate, renderPoll). Chaque interaction met à jour le state et appelle render().
Données Firestore
polls/
  {pollId}/
    title         string
    dates         string[]       — ["2025-06-14", "2025-06-21"]
    votes         map            — { "Alice": { "2025-06-14": "available" } }
    voterNames    map            — { userId: "Alice" }
    participantIds string[]      — [userId, ...]
    creatorId     string
    creatorName   string
    createdAt     timestamp
Identité utilisateur
Pas d'authentification. Chaque navigateur reçoit un userId persisté en localStorage (généré à la première visite). Le prénom est demandé une seule fois.

Lancer le projet en local
Cloner le repo et servir les fichiers avec n'importe quel serveur statique :
bashgit clone https://github.com/benjamindev17/tts.git
cd tts
npx serve .

⚠️ Firebase est déjà configuré et connecté au projet jeu-tts. Aucune variable d'environnement n'est nécessaire pour tester.


Règles Firestore (sécurité)
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /polls/{pollId} {
      allow read: if true;
      allow create: if true;
      allow update: if true;
      allow delete: if request.auth == null;
    }
  }
}

💡 Ces règles sont ouvertes pour correspondre au modèle sans auth. À renforcer si l'app passe en production réelle.

