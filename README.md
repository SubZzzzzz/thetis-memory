# Thetis Memory Extension

Extension globale de mémoire pour Pi (Thetis). Fournit un vault Markdown (compatible Obsidian) situé dans `~/.pi/agent/memory/`, un outil `memory` pour le consulter, et une injection automatique du résumé du vault dans le contexte système de chaque tour.

## Fonctionnalités

- **Vault global** : fichiers Markdown avec frontmatter YAML dans `~/.pi/agent/memory/`
- **Outil `memory`** : actions `read`, `list`, `search`
- **Contexte automatique** : le MOC (`MOC.md`) est injecté dans le system prompt à chaque tour
- **Skills intégrés** : les dossiers `~/.pi/agent/memory/skills/*/SKILL.md` sont découverts comme skills Pi natifs
- **Auto-save des sessions** : chaque session est archivée automatiquement à chaque tour et à la fermeture
- **Historique des sessions** : commande `/session-history` pour lister et restaurer une session précédente
- **Auto-cleanup** : suppression automatique des archives de session inactives depuis plus de 48h
- **Apprentissage** : commande `/learn` et tool `learn_wizard` pour extraire et sauvegarder des connaissances

## Installation manuelle

Copier ce dossier dans le répertoire des extensions globales de Pi :

```bash
# Créer le dossier d'extensions s'il n'existe pas
mkdir -p ~/.pi/agent/extensions

# Copier l'extension
cp -r /chemin/vers/thetis-memory ~/.pi/agent/extensions/

# Relancer Pi ou faire /reload
```

## Installation en tant que package Pi (recommandé)

Ajouter à `~/.pi/agent/settings.json` :

```json
{
  "packages": [
    "git:github.com/SubZzzzzz/thetis-memory"
  ]
}
```

Puis :

```bash
pi install git:github.com/SubZzzzzz/thetis-memory
```

## Structure du vault

```
~/.pi/agent/memory/
├── MOC.md
├── Conventions/
│   └── use-bun.md
├── User/
│   └── i-prefer-dark-mode.md
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

## Utilisation

### Via l'agent

L'agent connaît automatiquement les mémoires disponibles grâce au contexte injecté. Il peut utiliser le tool `memory` pour lire leur contenu complet.

### Commandes manuelles

- Lire une mémoire : demander à l'agent d'utiliser `memory/read` avec l'`id` ou le `title`
- Lister : demander `memory/list` (optionnellement filtré par `section`)
- Chercher : demander `memory/search` avec un mot-clé

### Skills du vault

Les skills du vault sont accessibles comme des skills natifs :

```
/skill:deploy-api
```

## Gestion des sessions

Les sessions sont automatiquement archivées dans `~/.pi/agent/memory/Sessions/` :

- Un snapshot est créé à **chaque tour** (`turn_end`) et à la **fermeture** (`session_shutdown`)
- Les snapshots portent le nom de la session et sont triés par date
- Les archives non utilisées depuis **48h** sont automatiquement supprimées au démarrage d'une nouvelle session

### Commandes de session

| Commande | Description |
|----------|-------------|
| `/session-history` | Lister les sessions archivées et en restaurer une |
| `/learn` | Lancer l'extraction interactive de mémoires/skills |
