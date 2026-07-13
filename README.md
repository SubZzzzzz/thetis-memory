# Thetis Memory Extension

Extension globale de mémoire pour **Pi** (Thetis). Fournit un vault Markdown (compatible Obsidian) situé dans `~/.pi/agent/memory/`, un outil `memory` pour le consulter et le gérer, un outil `learn_wizard` pour l'extraction interactive de connaissances, et une injection automatique du résumé du vault — accompagné d’un protocole impératif de lecture des mémoires pertinentes — dans le contexte système de chaque tour.

## Fonctionnalités

- **Vault global** — fichiers Markdown avec frontmatter YAML dans `~/.pi/agent/memory/`
- **Outil `memory`** — actions `read`, `list`, `search`, `move`, `delete`, `reorganize`
- **Outil `learn_wizard`** — extraction LLM des messages de session + wizard interactif de sauvegarde (select TUI)
- **Outil `tui_question`** — wizard TUI global pour confirmations, sélections, saisies texte et éditeur multi-lignes
- **Contexte automatique** — le MOC (`MOC.md`) est injecté dans le system prompt à chaque tour avec un protocole obligeant le LLM à lire les mémoires pertinentes avant de répondre
- **Skills intégrés** — les dossiers `~/.pi/agent/memory/skills/*/SKILL.md` sont découverts comme skills Pi natifs
- **Auto-save des sessions** — chaque session est archivée automatiquement à chaque tour et à la fermeture
- **Historique des sessions** — commande `/session-history` pour lister et restaurer une session précédente
- **Auto-cleanup** — suppression automatique des archives de session inactives depuis plus de 48h
- **Notifications TUI** — widget au-dessus de l'éditeur quand un outil memory, learn_wizard ou tui_question est utilisé
- **Gateway cross-extension** — si `thetis-gateway` est installé, les confirmations d'actions sensibles sont relayées sous forme de boutons Discord ou menu WhatsApp
- **Validation stricte des sections** — tous les chemins sont validés contre le path traversal

## Installation

### Prérequis

- **Node.js ≥ 18** (ou Bun)
- **Pi** ≥ 0.80 (`@earendil-works/pi-coding-agent`)
- Pour `learn_wizard/run` : un modèle doit être configuré avec `/model` (sinon l'extraction échoue avec « No model configured »)

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
│   └── react_api_a1b2c3d4.jsonl
└── skills/                          # Note : minuscule !
    └── deploy-api/
        └── SKILL.md
```

> **Note** : le dossier des skills est `skills/` (minuscule), tandis que les autres sections (`Conventions/`, `User/`) sont en `PascalCase`. Le MOC référence ces sections par leur nom d'affichage.

### MOC.md

Index du vault avec liens Obsidian `[[Titre]]`. Le fichier est **régénéré** à chaque modification du vault : toute édition manuelle (commentaires, ordre custom, sections `## Notes`, etc.) sera écrasée.

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

## Protocole de chargement mémoire

Le MOC injecté dans le system prompt contient un **MANDATORY MEMORY LOADING PROTOCOL** qui oblige le modèle à :

1. Scanner la carte des mémoires avant chaque réponse.
2. Invoquer `memory/read` sur tout titre, tag ou skill potentiellement pertinent.
3. Ne pas se fier aux seuls titres ni deviner — lire d’abord, répondre ensuite.
4. Utiliser `memory/search` en cas de doute.
5. Après lecture, ne garder une mémoire dans son raisonnement que si son contenu aide réellement à résoudre la demande.

Ce protocole reste une incitation au niveau du prompt : c’est le LLM qui invoque l’outil, mais de manière beaucoup plus explicite et impérative qu’auparavant.

## Outil `tui_question`

Wizard TUI global pour poser des questions interactives à l'utilisateur depuis n'importe quel contexte (outils, scripts, ou l'agent).

| Action | Description | Paramètres requis |
|--------|-------------|-------------------|
| `confirm` | Confirmation oui/non | `question` |
| `select` | Choix dans une liste d'options | `question`, `options` |
| `input` | Saisie texte courte | `question` |
| `editor` | Éditeur multi-lignes | `question` |

### Paramètres détaillés

```typescript
{
  action: "confirm" | "select" | "input" | "editor",
  question: string,                    // texte affiché
  options?: string[],                  // options pour select
  defaultValue?: string,               // valeur par défaut pour input/editor
  timeoutSeconds?: number              // timeout (défaut : aucun)
}
```

### Retour

Le tool retourne le texte de la réponse (`"yes"`, `"no"`, l'option choisie, le texte saisi, ou `"cancelled"` si l'utilisateur annule). En mode sans UI (`--print`, `--json`), le tool retourne une erreur.

## Outil `memory`

L'agent connaît automatiquement les mémoires disponibles grâce au contexte injecté et au protocole de chargement mémoire. Il peut utiliser le tool `memory` pour lire leur contenu complet ou les gérer.

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
  value?: string         // valeur reorganize (nouveau nom, source du merge, ou ordre CSV)
}
```

### Sécurité — confirmation interactive

Les actions **destructives ou structurantes** (`move`, `delete`, `reorganize`) nécessitent une confirmation de l'utilisateur :
- **En TUI** : boîte de dialogue de confirmation
- **Avec thetis-gateway** : boutons Discord interactifs ou menu WhatsApp
- **Sans UI** : l'action est annulée

Avant la confirmation, l'extension **résout l'identifiant** fourni (via `read`) pour afficher dans le message la cible exacte (`title` et `relPath`). Cela évite les suppressions/déplacements ambigus basés sur des matches partiels.

**Règles de validation des sections** : un nom de section ne peut pas contenir `/`, `\`, `..`, commencer par `.`, ni dépasser 64 caractères. Tout nom invalide est **rejeté avec une erreur explicite** avant même la confirmation.

## Outil `learn_wizard`

Extraction et sauvegarde de connaissances depuis la session courante.

| Action | Description | Confirmation |
|--------|-------------|--------------|
| `run` | Analyse les messages récents, extrait des candidats via LLM, puis lance un wizard interactif | Wizard par candidat |
| `save` | Sauvegarde directe d'un candidat déjà formé | **Toujours** (affiche un preview) |

### Wizard interactif (action `run`)

Le wizard présente chaque candidat via une **select list TUI** et demande :
- `yes` — sauvegarder
- `no` — ignorer
- `edit` — modifier via un sous-menu (titre, section, tags, contenu ou type)
- `all` — sauvegarder tous les candidats restants
- `none` — annuler tout

En cas de doublon (titre identique), le wizard propose :
- `overwrite` — écraser
- `skip` — ignorer
- `rename` — renommer (avec input interactif)

> **Amélioration** : le wizard utilise `ctx.ui.select()` au lieu de `ctx.ui.input()` pour toutes les étapes de choix, éliminant les erreurs de frappe et accélérant la navigation clavier.

### Sauvegarde directe (action `save`)

Avant d'écrire, l'extension :
1. Valide `section` (rejet du path traversal)
2. Vérifie la taille de `content` (max 100 KB, voir [Limitations](#limitations))
3. Affiche un aperçu (type, titre, section, tags, path cible, preview 240 chars du contenu)
4. Demande confirmation à l'utilisateur

### Granularité

- `generic` (défaut) — règles larges et réutilisables
- `specific` — notes concrètes de session

### Limite d'extraction

Les messages de session envoyés à l'API d'extraction sont **tronqués à 15 000 caractères** (les plus récents en priorité, préfixés de `...[truncated]...`).

### Checkpoint

Le wizard utilise un checkpoint (`~/.pi/agent/memory/.checkpoint.json`) pour ne pas réanalyser les messages déjà traités. Chaque `run` avance le checkpoint. Pour forcer une ré-analyse complète, supprimez ce fichier.

### Prérequis

`learn_wizard/run` effectue un appel direct à l'API du modèle courant (OpenAI, Anthropic, ou compatible). **Un modèle doit être configuré** avec `/model` avant d'utiliser cette action. Sans modèle, l'erreur `No model configured. Set a model with /model before using /learn.` est levée.

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

Les archives sont nommées automatiquement par extraction de mots-clés depuis les messages utilisateur, suivis de l'identifiant court de session (8 hex chars). Exemple : `react_api_a1b2c3d4.jsonl` (le slug du sujet, `_`, les 8 premiers chars du `sessionId`).

## Gestion des sessions

Les sessions sont automatiquement archivées dans `~/.pi/agent/memory/Sessions/` :

- Un snapshot est créé à **chaque tour** (`turn_end`) et à la **fermeture** (`session_shutdown`)
- Les snapshots portent un nom généré à partir du sujet de conversation + identifiant court de session
- Les archives non utilisées depuis **48h** sont automatiquement supprimées au démarrage d'une nouvelle session
- Le contenu `thinking` est **filtré** des archives (uniquement les blocs de réflexion des messages assistant sont retirés ; le reste du contenu, y compris les résultats d'outils, est préservé)

> ⚠️ Les sessions archivées contiennent l'historique complet de la conversation (hors blocs `thinking`). Ne stockez pas d'informations hautement sensibles dans des sessions qui seront archivées.

## Intégration Gateway

Si `thetis-gateway` est installé et actif :
- Les outils `memory` et `learn_wizard` fonctionnent depuis Discord et WhatsApp
- Les actions sensibles (`move`, `delete`, `reorganize`, `learn_wizard/save`) déclenchent des confirmations interactives sur la plateforme (boutons Discord, liste WhatsApp)
- Les résultats des outils sont relayés dans le canal actif
- Le mécanisme utilise la fonction globale `globalThis.__gatewayConfirm` (avec try/catch + coercion en booléen, fallback sur le TUI si la fonction throw)

## Modèle de sécurité

L'extension applique plusieurs couches de défense :

1. **Validation des chemins** — Tous les noms de sections passent par `safeSection()` qui rejette `/`, `\`, `..`, les préfixes `.`, les caractères de contrôle, et les longueurs > 64 chars. Appliqué dans `saveCandidate`, `handleMove`, `handleReorganize`.
2. **Validation des slugs** — Les titres sont convertis en slug `[a-z0-9-]` via `toSlug()` puis validés par `safeSlug()` (rejet si vide, préfixé `.`, ou > 64 chars).
3. **Limite de taille** — Les contenus de plus de 100 KB sont refusés avant l'écriture.
4. **Confirmation obligatoire** — `move`, `delete`, `reorganize`, et `learn_wizard/save` requièrent une confirmation utilisateur explicite.
5. **Résolution avant confirmation** — L'identifiant est résolu (title + relPath) avant l'affichage de la confirmation, pour éviter les matches ambigus.
6. **Validation de la gateway** — `__gatewayConfirm` est validée comme fonction, son retour est coercé en `Boolean`, et toute exception fait retomber sur la confirmation TUI standard.
7. **Refus en mode sans UI** — Sans UI (mode `--print`, `--json`), les actions destructives sont annulées (retournent « cancelled by user »).

⚠️ **Caveats** :
- Le contenu des sessions archivées n'est pas chiffré et reste lisible par tout processus ayant accès au système de fichiers.
- La fonction `__gatewayConfirm` est un point d'extension global : une autre extension compromise pourrait l'écraser. Elle est validée à l'appel mais le contrôle du global lui-même est hors de portée de cette extension.
- Le parser YAML interne est volontairement simple (ne gère pas les structures imbriquées, multi-lignes, anchors). Une round-trip sur un frontmatter riche peut perdre de l'information.

## Limitations

- **Parser YAML limité** : `parseFrontmatter`/`stringifyFrontmatter` ne gèrent pas les valeurs multi-lignes (`|`/`>`), les objets imbriqués, les anchors, ni les types non-string. Les frontmatters complexes importés d'Obsidian peuvent perdre de l'info à chaque ré-écriture.
- **Limite d'extraction LLM** : 15 000 caractères (les plus récents en priorité).
- **Limite de taille par fichier** : 100 KB (`MAX_CONTENT_CHARS`). Les contenus plus gros sont refusés.
- **I/O synchrones** : `fs.readFileSync` / `fs.writeFileSync` partout. Sur un vault de 200+ fichiers, `buildMemoryContext` à chaque tour peut être perceptible.
- **MOC.md régénéré** : toute édition manuelle est écrasée au prochain changement.
- **`archiveSession` à chaque tour** : le fichier de session complet est ré-écrit (filtré) à chaque `turn_end`. Pas de debouncing.
- **Sections par défaut** : `Conventions`, `User`, `Skills` (mais le dossier `skills/` est en minuscule dans le filesystem).
- **`__gatewayConfirm`** : mécanisme ad-hoc via `globalThis`, pas d'API Pi officielle. Une autre extension peut écraser ce global.
- **Globaux mutables** : l'état du widget de notification est en module-scope (non isolé par session).
- **Pas d'API publique** : le vault ne peut être géré que via le tool `memory` exposé à l'agent. Pas de CLI pour l'édition directe.

## Troubleshooting

### Le tool `memory` semble ne rien faire

Vérifiez que la console ne montre pas d'erreur. Le tool exige une UI (TUI ou RPC gateway) pour les actions destructives. En mode `--print`/`--json`, ces actions retournent « cancelled by user ».

### `/learn` échoue avec « No model configured »

Lancez `/model` et choisissez un modèle (OpenAI, Anthropic, etc.) avant d'utiliser `/learn`. L'extraction a besoin d'un appel LLM.

### Une mémoire importée d'Obsidian perd son frontmatter

Le parser YAML de l'extension est limité. Les valeurs multi-lignes, les objets imbriqués et les anchors YAML ne sont pas préservés lors d'une ré-écriture. Si la mémoire ne doit pas être modifiée, ne la touchez pas via l'agent (utilisez un éditeur externe).

### Le widget TUI ne s'affiche pas

Le widget apparaît au-dessus de l'éditeur uniquement après qu'un outil `memory` ou `learn_wizard` a été exécuté. Si vous êtes en mode `--print`/`--json`, le widget n'est pas visible (pas d'UI).

### Forcer une ré-analyse complète de la session pour `/learn`

```bash
rm ~/.pi/agent/memory/.checkpoint.json
```

### Restaurer manuellement une session archivée

Les archives JSONL sont dans `~/.pi/agent/memory/Sessions/`. Utilisez `/session-history` pour les restaurer interactivement, ou copiez le fichier `.jsonl` dans le dossier de sessions de Pi et utilisez `/resume` (cf. doc Pi).

### Récupérer un fichier supprimé par erreur

Les suppressions passent par `fs.unlinkSync` (mémoires) ou `fs.rmSync({recursive: true})` (skills). Il n'y a **pas de corbeille** : si vous avez confirmé un `delete` par erreur, restaurez depuis votre backup système.

## Fichiers

```
thetis-memory/
├── index.ts         # Extension principale
├── package.json     # Manifest pi-package
├── README.md        # Documentation
└── .gitignore
```

## Dépendances

**Aucune dépendance runtime externe.** L'extension utilise uniquement les API internes de Pi et les modules natifs Node.js (`fs`, `path`, `os`).

Peer dependencies (fournies par Pi) :
- `@earendil-works/pi-coding-agent` (^0.80)
- `typebox`
- `@earendil-works/pi-ai`

## Changelog

### 1.2.1 (protocole de chargement mémoire)
- **NEW** : `MANDATORY MEMORY LOADING PROTOCOL` injecté avec le MOC dans le system prompt.
- Le protocole oblige le LLM à scanner le MOC, à invoquer `memory/read` sur les mémoires pertinentes, et à ignorer celles qui n’aident pas à résoudre la demande.

### 1.2.0 (wizard TUI global)
- **NEW** : outil `tui_question` — wizard TUI global avec 4 modes : `confirm`, `select`, `input`, `editor`. Utilisable par tout outil ou l'agent pour interagir avec l'utilisateur en TUI.
- **IMPROVE** : `learn_wizard` utilise désormais `ctx.ui.select()` pour toutes les étapes de choix (save, edit, duplicate, type), remplaçant les prompts texte libres par des listes de sélection navigables au clavier.
- **IMPROVE** : le widget de notification TUI inclut désormais `tui_question`.
- **FIX** : suppression des boucles récursives infinies dans `askSave` et `handleDuplicate` en cas de réponse invalide (remplacées par des returns explicites).

### 1.1.0 (sécurité)
- **FIX CRITIQUE** : `pi.registerTool` était appelé avec deux arguments ; le second (contenant `execute`) était silencieusement ignoré, rendant le tool `memory` non-fonctionnel. Fusionné en un seul argument.
- **FIX sécurité** : validation `safeSection()` contre le path traversal sur `saveCandidate`, `handleMove`, `handleReorganize` (merge_sections + rename_section).
- **FIX sécurité** : validation `safeSlug()` pour les titres (rejet de `..`, vide, > 64 chars).
- **FIX sécurité** : `learn_wizard/save` requiert désormais une confirmation utilisateur avec preview du contenu et du chemin cible.
- **FIX** : `handleDelete` et `handleMove` résolvent l'identifiant (via `findEntry`) **avant** la confirmation, pour afficher le titre exact et le relPath dans le dialogue.
- **FIX** : `__gatewayConfirm` enveloppe l'appel dans un `try/catch` et coerce le retour en `Boolean`.
- **NEW** : limite de taille `MAX_CONTENT_CHARS` (100 KB) appliquée à `saveCandidate` et `learn_wizard/save`.
- **NEW** : `merge_sections` refuse si source = destination et évite les écrasements silencieux.
- **NEW** : helper `findEntry()` partagé entre `handleRead`, `handleMove`, `handleDelete`.

### 1.0.0
- Version initiale : vault, outils `memory` et `learn_wizard`, injection du MOC dans le system prompt, archivage de sessions, intégration gateway.

## Licence

MIT — © Achille Robbe
