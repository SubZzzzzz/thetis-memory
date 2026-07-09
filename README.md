# Thetis Memory Extension

Extension globale de mémoire pour **Pi** (Thetis). Fournit un vault Markdown (compatible Obsidian) situé dans `~/.pi/agent/memory/`, un outil `memory` pour le consulter et le gérer, un outil `learn_wizard` pour l'extraction interactive de connaissances, et une injection automatique du résumé du vault dans le contexte système de chaque tour.

## Fonctionnalités

- **Vault global** — fichiers Markdown avec frontmatter YAML dans `~/.pi/agent/memory/`
- **Outil `memory`** — actions `read`, `list`, `search`, `move`, `delete`, `reorganize`
- **Outil `learn_wizard`** — extraction LLM des messages de session + wizard interactif de sauvegarde
- **Contexte automatique** — le MOC (`MOC.md`) est injecté dans le system prompt à chaque tour
- **Skills intégrés** — les dossiers `~/.pi/agent/memory/skills/*/SKILL.md` sont découverts comme skills Pi natifs
- **Auto-save des sessions** — chaque session est archivée automatiquement à chaque tour et à la fermeture
- **Historique des sessions** — commande `/session-history` pour lister et restaurer une session précédente
- **Auto-cleanup** — suppression automatique des archives de session inactives depuis plus de 48h
- **Notifications TUI** — widget au-dessus de l'éditeur quand un outil memory est utilisé
- **Gateway cross-extension** — si `thetis-gateway` est installé, les confirmations d'actions sensibles (delete, move, reorganize) sont relayées sous forme de boutons Discord ou menu WhatsApp

## Installation

### Via `pi install` (recommandé)

```bash
pi install git:github.com/SubZzzzzz/thetis-memory
```

Ou temporairement :

```bash
pi -e git:github.com/SubZzzzzz/thetis-memory
```

### Manuelle

```bash
# Créer le dossier d'extensions s'il n'existe pas
mkdir -p ~/.pi/agent/extensions

# Cloner
git clone https://github.com/SubZzzzzz/thetis-memory.git ~/.pi/agent/extensions/thetis-memory

# Relancer Pi ou faire /reload
```

## Structure du vault

```
~/.pi/agent/memory/
├── MOC.md
├── Conventions/
│   └── use-bun.md
├── User/
│   └── i-prefer-dark-mode.md
├── Sessions/
│   └── react_api_2026_07_08_a1b2c3d4.jsonl
└── skills/
    └── deploy-api/
        └── SKILL.md
```

### MOC.md

Index du vault avec liens Obsidian `[[Titre]]` :

```markdown
---
title: Pi Memory
tags: [moc, memory]
---

# Memory

## Conventions

- [[Use Bun]]

## User

- [[I prefer dark mode]]

## Skills

- [[Deploy API]]
```

### Fichiers mémoire

```markdown
---
id: use-bun
title: Use Bun
tags: [convention, learned]
updated: 2026-07-08
---

In this project we use Bun as the package manager and runtime.
```

### Fichiers skill

```markdown
---
name: deploy-api
description: How to deploy the API to production
tags: [skill, learned]
---

1. Run tests: `bun test`
2. Build: `bun run build`
3. Deploy: `bun run deploy:prod`
```

## Outil `memory`

L'agent connaît automatiquement les mémoires disponibles grâce au contexte injecté. Il peut utiliser le tool `memory` pour lire leur contenu complet ou les gérer.

| Action | Description | Paramètres requis |
|--------|-------------|-------------------|
| `read` | Charger le contenu complet d'une mémoire par `id` ou `title` | `id` |
| `list` | Lister les mémoires, filtrable par `section` | — |
| `search` | Chercher dans les titres, tags et contenus | `query` |
| `move` | Déplacer une mémoire dans une autre section (optionnellement renommer) | `id`, `newSection` (ou `section`) |
| `delete` | Supprimer définitivement une mémoire | `id` |
| `reorganize` | Renommer/fusionner des sections ou réordonner les items | `operation`, `target`, `value` |

### Paramètres détaillés

```typescript
{
  action: "read" | "list" | "search" | "move" | "delete" | "reorganize",
  id?: string,           // pour read, move, delete
  section?: string,      // filtre list ou destination move
  query?: string,        // pour search
  newSection?: string,   // destination move
  newTitle?: string,     // renommage move
  operation?: "rename_section" | "merge_sections" | "reorder_items",
  target?: string,       // cible reorganize
  value?: string         // valeur reorganize
}
```

### Sécurité — confirmation interactive

Les actions **destructives ou structurantes** (`move`, `delete`, `reorganize`) nécessitent une confirmation de l'utilisateur :
- **En TUI** : boîte de dialogue de confirmation
- **Avec thetis-gateway** : boutons Discord interactifs ou menu WhatsApp
- **Sans UI** : l'action est annulée

## Outil `learn_wizard`

Extraction et sauvegarde de connaissances depuis la session courante.

| Action | Description |
|--------|-------------|
| `run` | Analyse les messages récents, extrait des candidats via LLM, puis lance un wizard interactif pour les réviser et sauvegarder un par un |
| `save` | Sauvegarde directe d'un candidat déjà formé, sans wizard |

### Wizard interactif

Lors d'un `run`, le wizard présente chaque candidat et demande :
- `yes` — sauvegarder
- `no` / `skip` — ignorer
- `edit` — modifier le titre, section, tags, contenu ou type
- `all` — sauvegarder tous les candidats restants
- `none` — annuler tout

En cas de doublon (titre identique), le wizard propose :
- `overwrite` — écraser
- `skip` — ignorer
- `rename` — renommer

### Granularité

- `generic` (défaut) — règles larges et réutilisables
- `specific` — notes concrètes de session

### Checkpoint

Le wizard utilise un checkpoint (`~/.pi/agent/memory/.checkpoint.json`) pour ne pas réanalyser les messages déjà traités. Chaque `run` avance le checkpoint.

## Commandes

### `/learn`

Lance le wizard d'extraction sur la session courante.

```
/learn
/learn --granularity specific
```

### `/session-history`

Liste les sessions archivées et permet d'en restaurer une.

```
/session-history
```

Les archives sont nommées automatiquement par extraction de mots-clés depuis les messages utilisateur (ex: `react_api_a1b2c3d4.jsonl`).

## Gestion des sessions

Les sessions sont automatiquement archivées dans `~/.pi/agent/memory/Sessions/` :

- Un snapshot est créé à **chaque tour** (`turn_end`) et à la **fermeture** (`session_shutdown`)
- Les snapshots portent un nom généré à partir du sujet de conversation + identifiant court de session
- Les archives non utilisées depuis **48h** sont automatiquement supprimées au démarrage d'une nouvelle session
- Le contenu `thinking` est filtré pour réduire la taille

## Intégration Gateway

Si `thetis-gateway` est installé et actif :
- Les outils `memory` et `learn_wizard` fonctionnent depuis Discord et WhatsApp
- Les actions sensibles (`move`, `delete`, `reorganize`) déclenchent des confirmations interactives sur la plateforme (boutons Discord, liste WhatsApp)
- Les résultats des outils sont relayés dans le canal actif

## Fichiers

```
thetis-memory/
├── index.ts         # Extension principale
├── package.json     # Manifest pi-package
├── README.md        # Documentation
└── .gitignore
```

## Dépendances

Aucune dépendance runtime externe. L'extension utilise uniquement les API internes de Pi et les modules natifs Node.js (`fs`, `path`).

Peer dependencies :
- `@earendil-works/pi-coding-agent`
- `typebox`
- `@earendil-works/pi-ai`

## Licence

MIT — © Achille Robbe
