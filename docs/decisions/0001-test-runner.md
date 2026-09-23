# 0001 - Test runner for mutation testing under Vite+

- Statut : accepté
- Date : 2026-09-21
- Spike : T00 (bloquant pour tout le scaffold CI)

## Question

`@stryker-mutator/vitest-runner` peut-il piloter le même Vitest que celui utilisé par Vite+,
dans un seul projet, sans conflit de version ?

Vite+ embarque son propre Vitest. Le runner Stryker, lui, résout `vitest` depuis
`node_modules` du projet. Si les deux divergent, toute la conception de la CI change.

## Réponse courte

Oui, à une condition dure : **`vitest` doit être épinglé à la version exacte embarquée par
Vite+ (`4.1.11` pour `vite-plus@0.3.3`)**. Avec `vitest@5.0.1`,
`@stryker-mutator/vitest-runner@10.0.0` échoue **silencieusement** : score 0 %, tous les
mutants « survived », exit code 0, aucun message d'erreur. C'est le pire mode de panne
possible pour une CI de mutation testing.

Nuance à ne pas masquer : Stryker et `vp test` n'exécutent pas la *même instance* de Vitest.
Stryker charge le `vitest` racine (`node_modules/vitest`), Vite+ charge le sien, imbriqué
dans son propre sous-arbre. Même version, deux copies dans le store pnpm. Les résultats
concordent sur le spike, mais rien ne le garantit si Vite+ patche son Vitest ou avance de
version sans que l'on suive.

## Environnement de mesure

Toutes les durées ci-dessous sont des mesures réelles (`time`, wall-clock), pas des
estimations.

| Élément | Valeur |
|---|---|
| Machine | Intel Core i5-1145G7 @ 2.60 GHz, 4 cœurs / 8 threads, 31.7 Go RAM |
| OS | Windows 11 Enterprise 10.0.26200 |
| Shell | Git Bash (`time` de bash) |
| Node | v24.19.0 |
| pnpm | 11.24.0 |
| git | 2.55.0.windows.5 |
| Répertoire du spike | `C:\Users\mletrone\AppData\Local\Temp\vps2` (chemin court, voir « Piège MAX_PATH ») |

Le spike : un fichier `src/compare.ts` (2 fonctions, un `>=` et un `>`), un fichier
`src/compare.spec.ts` (4 tests). Stryker y génère **11 mutants**.

## Versions exactes installées (`pnpm list --depth=0`)

```
@stryker-mutator/core                10.0.0
@stryker-mutator/typescript-checker  10.0.0
@stryker-mutator/vitest-runner       10.0.0
@vitest/coverage-v8                  4.1.11
typescript                           6.0.3
vite-plus                            0.3.3
vitest                               4.1.11
```

Ce que `vite-plus@0.3.3` embarque (lu dans son `package.json`) :

```
vitest            4.1.11                                   <- la version qui fait autorité
vite              npm:@voidzero-dev/vite-plus-core@0.3.3    (alias, pas le vrai vite)
@vitest/*         4.1.11
oxfmt             =0.68.0
oxlint            =1.83.0
oxlint-tsgolint   =7.0.2001
```

Peer dependency déclarée par `@stryker-mutator/vitest-runner@10.0.0` : `"vitest": ">=2.0.0"`.
Elle est donc **permissive et trompeuse** : `vitest@5.0.1` la satisfait et casse quand même.

## Commandes exécutées, sorties réelles et durées

### 1. `pnpm exec vp test --run`

```
 RUN  v4.1.11
 Test Files  1 passed (1)
      Tests  4 passed (4)
   Duration  492ms
exit=0
```

Wall-clock : **7,52 s** (dont ~7 s de démarrage `pnpm exec` + `vp`).

### 2. `pnpm exec vp test --run --coverage`

Premier essai, sans provider :

```
 MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-v8'
```

Après `pnpm add -D @vitest/coverage-v8@4.1.11` :

```
 Test Files  1 passed (1)
      Tests  4 passed (4)
   Duration  584ms
Statements   : 100% ( 4/4 )
Branches     : 100% ( 2/2 )
exit=0
```

Wall-clock : **9,74 s**.

Provider nécessaire : **`@vitest/coverage-v8`, épinglé à `4.1.11`** (même contrainte que
`vitest` : il doit suivre la version Vite+, pas la dernière publiée).

### 3. `stryker run` avec `testRunner: "vitest"`

Trois échecs successifs avant que ça marche. Ils comptent, parce qu'ils se reproduiront
chez les clients.

**Échec A - `typescript@7.0.2`**

```
ERROR Stryker Unexpected error occurred while running Stryker
TypeError: ts.parseConfigFileTextToJson is not a function
    at TSConfigPreprocessor.rewriteTSConfigFile (.../sandbox/ts-config-preprocessor.js:46:39)
```

`typescript@7.x` est le paquet natif (tsgo) : il n'expose plus l'API classique du compilateur.
`@stryker-mutator/core@10.0.0` en dépend. Vérifié : `Object.keys(require('typescript'))`
ne contient aucun export `parseConfig*` en 7.0.2, et en contient en 6.0.3.
Correctif : **`typescript@6.0.3`**.

**Échec B - découverte des plugins**

```
ERROR Stryker Cannot find TestRunner plugin "vitest".
In fact, no TestRunner plugins were loaded. Did you forget to install it?
```

Le défaut `plugins: ["@stryker-mutator/*"]` (glob sur `node_modules`) ne fonctionne pas avec
l'arborescence isolée de pnpm, dans le process enfant sandboxé.
Correctif : **lister les plugins explicitement** dans `stryker.config.json`.

**Échec C - le faux négatif silencieux, `vitest@5.0.1`**

```
Ran 0.00 tests per mutant on average.
All files   |   0.00 |    0.00 |        0 |         0 |         11 |        0 |        0 |
```

11 mutants sur 11 « survived », score 0,00 %, **aucune erreur, aucun avertissement**.
Le dry run passe pourtant (« Initial test run succeeded. Ran 4 tests »). Seul le run
par mutant n'exécute aucun test.

Diagnostic par expérience de contrôle, dans un projet séparé **sans Vite+**
(`vitest` + vrai `vite` + Stryker seulement) :

| Projet de contrôle | vitest | vite | Résultat |
|---|---|---|---|
| sans Vite+ | 5.0.1 | 8.3.0 | 0,00 % - 11 survived, « Ran 0.00 tests per mutant » |
| sans Vite+ | 4.1.11 | 7.3.6 | **90,91 %** - 10 killed, 1 survived, « Ran 1.36 tests per mutant » |

**Ce n'est donc pas un conflit Vite+.** C'est une incompatibilité
`@stryker-mutator/vitest-runner@10.0.0` x `vitest@5.x`, qui échoue sans le dire.
Vite+ est innocent ; il impose juste, indirectement, la bonne version.

Les autres pistes ont été essayées et écartées : `vitest.related: false` et
`coverageAnalysis: "off"` donnent exactement le même 0,00 %.

**Succès - configuration retenue**

```
INFO ProjectReader Found 1 of 8 file(s) to be mutated.
INFO Instrumenter Instrumented 1 source file(s) with 11 mutant(s)
INFO DryRunExecutor Initial test run succeeded. Ran 4 tests in 0 seconds
Ran 1.36 tests per mutant on average.
All files   |  90.91 |   90.91 |       10 |         0 |          1 |        0 |        0 |
INFO MutationTestExecutor Done in 8 seconds.
```

Wall-clock : **11,62 s** (Stryker rapporte 8 s de son côté).

Le seul mutant survivant est l'`EqualityOperator` `value > max` -> `value >= max`, qu'aucun
des 4 tests ne distingue. C'est le résultat attendu : le spike a été écrit pour ça.

### 4. `checkers: ["typescript"]`

Fonctionne, avec `typescript@6.0.3` et `@stryker-mutator/typescript-checker@10.0.0`.

```
INFO ConcurrencyTokenProvider Creating 1 checker process(es) and 1 test runner process(es).
Ran 1.18 tests per mutant on average.
All files   |  88.89 |   88.89 |        8 |         0 |          1 |        0 |        2 |
INFO MutationTestExecutor Done in 13 seconds.
```

Wall-clock : **17,23 s**.

Coût mesuré sur ce spike : **+5 s côté Stryker (8 s -> 13 s), +5,6 s wall-clock
(11,62 s -> 17,23 s)**, pour 11 mutants et un seul fichier. Deux mutants sont reclassés en
`# errors` (ils ne compilent pas) et sortent du dénominateur : le score passe de 90,91 % à
88,89 %, ce qui est plus honnête, pas moins bon.

Attention : ce surcoût est essentiellement un coût de **démarrage** (un process checker en
plus, un programme TS à charger). Il ne se réplique pas par mutant ici, mais il n'a pas été
mesuré sur un projet réaliste. Ne pas extrapoler ce +5 s à un vrai dépôt.

À noter, lu dans le schéma Stryker : `typescriptChecker.experimentalNativePreview` permet
d'utiliser TypeScript 7 via l'alias `@typescript/native`. **Non testé.** Inutile ici puisque
TS 6.0.3 fait le travail, mais c'est la porte de sortie le jour où TS 6 ne suffira plus.

### 5. Fallback évalué quand même : `testRunner: "command"`

Le chemin `vitest-runner` marche, donc le fallback n'était pas requis. Mesuré tout de même,
pour chiffrer ce que l'on gagne.

Config :
`{"testRunner":"command","commandRunner":{"command":"pnpm exec vp test --run"},"coverageAnalysis":"off","concurrency":2}`

```
INFO DryRunExecutor Initial test run succeeded. Ran 1 tests in 7 seconds
Ran 1.00 tests per mutant on average.
All files   |  90.91 |   90.91 |       10 |         0 |          1 |        0 |        0 |
INFO MutationTestExecutor Done in 57 seconds.
```

Wall-clock : **59,52 s**.

| Runner | Stryker | Wall-clock | Score |
|---|---|---|---|
| `vitest` | 8 s | 11,62 s | 90,91 % |
| `command` (`vp test --run`) | 57 s | 59,52 s | 90,91 % |

**7,1x plus lent sur 11 mutants** (57 / 8), et ce ratio empire avec le nombre de mutants :
le command runner relance tout le process Vitest par mutant et ne sait pas faire de
`coverageAnalysis: "perTest"` (« Ran 1.00 tests per mutant » contre 1,36 : il exécute la
suite entière à chaque fois). Le score est identique, donc le fallback est *correct* ; il
est juste inutilisable à l'échelle.

## Décision

**Runner de tests Stryker : `vitest`**, avec `vitest` et `@vitest/coverage-v8` épinglés à
la version exacte embarquée par Vite+ (`4.1.11` pour `vite-plus@0.3.3`), et `typescript`
maintenu en `6.0.3`. Le `command` runner est le plan B documenté, pas le plan A.

## Conséquences pour le scaffold

### `package.json`

Les versions sont épinglées **sans `^`**. C'est volontaire : un `^vitest@4` laisserait
passer une 5.x et rendrait la CI verte à 0 % de score.

```json
{
  "type": "module",
  "packageManager": "pnpm@11.24.0",
  "scripts": {
    "fmt": "vp fmt --check",
    "fmt:fix": "vp fmt",
    "lint": "vp lint",
    "typecheck": "vp check --no-fmt --no-lint",
    "test": "vp test --run",
    "test:cov": "vp test --run --coverage",
    "mutate": "stryker run"
  },
  "devDependencies": {
    "@stryker-mutator/core": "10.0.0",
    "@stryker-mutator/typescript-checker": "10.0.0",
    "@stryker-mutator/vitest-runner": "10.0.0",
    "@vitest/coverage-v8": "4.1.11",
    "typescript": "6.0.3",
    "vite-plus": "0.3.3",
    "vitest": "4.1.11"
  }
}
```

Deux pièges de scripts, vérifiés :

- `vp test` déclenche l'avertissement « You are running `vp test` as a Vite+ built-in
  command. If you meant to run the test npm script, use `vpr test` instead. » `vp` est la
  commande Vite+, `vpr` le lanceur de scripts npm. Le script npm `test` ne doit donc
  **jamais** s'appeler via `vp test` en interne, sous peine de récursion.
- `stryker run` via `pnpm exec` peut échouer avant même de démarrer si pnpm refuse
  l'install-state (`[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@...`, et
  `pnpm exec` sort en 1). En CI, appeler
  `node node_modules/@stryker-mutator/core/bin/stryker.js run`, ou approuver les builds
  explicitement.

### `stryker.config.json`

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "testRunner": "vitest",
  "plugins": [
    "@stryker-mutator/vitest-runner",
    "@stryker-mutator/typescript-checker"
  ],
  "checkers": ["typescript"],
  "tsconfigFile": "tsconfig.json",
  "coverageAnalysis": "perTest",
  "mutate": ["src/**/*.ts", "!src/**/*.spec.ts"],
  "reporters": ["clear-text", "progress", "html"],
  "incremental": true,
  "incrementalFile": "reports/stryker-incremental.json"
}
```

- `plugins` **doit** être explicite (échec B). Ne pas se fier au défaut.
- `packageManager: "pnpm"` a été retiré : il pousse Stryker à relancer `pnpm install` dans
  le sandbox, ce qui rate pour des raisons sans rapport avec le test.
- Clés Vite+ du runner vérifiées dans le schéma livré :
  `vitest.related` (bool, défaut `true`), `vitest.dir`, `vitest.configFile`. Aucune n'a été
  nécessaire.

### `.gitignore`

`node_modules/`, `coverage/`, `.stryker-tmp/`, `reports/`.

Ce n'est pas cosmétique. Sans `.gitignore`, `vp lint` et `vp fmt` descendent dans
`node_modules` : **2 min 36 s** de lint et des centaines de faux positifs mesurés sur le
spike, contre **6,8 s** une fois le `.gitignore` en place. Et sans `.stryker-tmp/` exclu,
`vp test --coverage` agrège les sandboxes Stryker laissés derrière et sort un rapport de
couverture faux (observé : deux entrées `sandbox-XXXXXX/src/compare.ts` dans le tableau).

### `vite.config.ts`

**Oui, `vp` a besoin d'un `vite.config.ts`** pour la config de fmt / lint / test. Sans lui,
`vp fmt` affiche « No config found, using defaults. Please add a config file or try
`vp fmt --init` if needed. »

Ne pas deviner la forme des clés : `vp fmt --init` et `vp lint --init` écrivent les blocs
eux-mêmes dans `vite.config.ts`. Sortie littérale de ces deux commandes :

```ts
import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    ignorePatterns: [],
  },
  test: {
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts"],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
```

- **Règles oxlint** : clé `lint.rules`, forme
  `{ "<plugin>/<rule>": "error" | "warn" | "off" }`. Plugins JS via
  `lint.jsPlugins: [{ name, specifier }]`. Type-aware via `lint.options.typeAware` et
  `lint.options.typeCheck`. `vp lint --print-config` dump la config effective résolue :
  s'en servir plutôt que de supposer.
- **Seuils de couverture** : clé `test.coverage.thresholds`, avec `lines` / `branches` /
  `functions` / `statements`. **Prouvé** : couverture à 57,14 % contre un seuil à 80 % donne
  `ERROR: Coverage for lines (57.14%) does not meet global threshold (80%)` et **exit 1** ;
  couverture à 100 % donne exit 0.
- `vp check --no-fmt --no-lint` ne type-check que si `lint.options.typeCheck` est à `true`.
  L'aide le dit : « Skip lint rules; type-check still runs when `lint.options.typeCheck` is
  true ». Sortie sur succès : `pass: Found no type errors in 3 files (801ms, 8 threads)`,
  exit 0. Avec une erreur de type introduite volontairement :
  `Found 1 error and 0 warnings in 3 files (775ms, 8 threads)`, **exit 1**.
  Wall-clock : 8,51 s.

### Imports dans les specs

La règle `vite-plus/prefer-vite-plus-imports` (activée par `vp lint --init`) exige
`import { ... } from "vite-plus/test"` et **refuse** `from "vitest"`. Vérifié : Stryker et
son `vitest-runner` fonctionnent identiquement avec les deux formes (90,91 %, 1,36 tests par
mutant dans les deux cas). Le scaffold utilisera donc `vite-plus/test`.

## Correction d'un « fait projet » : `vp fmt` n'est PAS en mode check par défaut

Le brief affirmait : « `vp fmt` (check mode by default, `--fix` writes) ». **C'est faux**, et
c'est le genre d'erreur qui rend une CI verte alors qu'elle réécrit le dépôt.

`vp fmt --help`, texte littéral :

```
Output Options:
  --write           Format and write files in place (default)
  --check           Check if files are formatted, also show statistics
  --list-different  List files that would be changed
```

Preuve empirique, fichier contenant `export  const   ugly=1` :

| Commande | Exit | Fichier après |
|---|---|---|
| `vp fmt src` | **0** | **réécrit** en `export const ugly = 1;` |
| `vp fmt src --check` | **1** | inchangé, `Format issues found in above 1 files. Run without --check to fix.` |

Il n'existe pas de `--fix` sur `vp fmt` (c'est `--write`) ; `--fix` est un flag de
`vp check`. En CI : **`vp fmt --check`**, jamais `vp fmt`.

## `vp --version` - sortie exacte à épingler

```
vp v0.3.3

Local vite-plus:
  vite-plus  v0.3.3

Tools:
  vite             Not found
  rolldown         Not found
  vitest           Not found
  oxfmt            Not found
  oxlint           Not found
  oxlint-tsgolint  Not found
  tsdown           Not found
```

La section « Tools: Not found » est **normale** et ne signale pas une installation cassée :
`vp fmt`, `vp lint` et `vp test` fonctionnent parfaitement dans cet état. Elle liste les
outils que l'on pourrait installer soi-même pour surcharger ceux embarqués par Vite+.
La ligne à asserter en CI est la première : `vp v0.3.3`.

## Piège Windows découvert en route : MAX_PATH

Sur un chemin de travail long, `vp lint` en mode type-aware échoue :

```
The system cannot find the path specified.
Error running tsgolint: "exit status: exit code: 1"
```

Bissection minimale : la panne apparaît dès qu'on ajoute `@vitest/coverage-v8` en dépendance
directe. Non pas parce que ce paquet est en cause, mais parce qu'il s'ajoute au hash de peer
dependencies de pnpm et rallonge le nom du répertoire du store :

```
node_modules/.pnpm/vite-plus@0.3.3_@vitest+coverage-v8@4.1.11_typescript@7.0.2/node_modules/oxlint-tsgolint/bin/tsgolint.js
```

Chemin complet mesuré : **263 caractères**, au-delà de la limite de 260.
`HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled` vaut **0** sur cette
machine.

Contre-épreuve décisive : dépendances **strictement identiques**, projet déplacé dans
`C:\Users\mletrone\AppData\Local\Temp\vps` donne `vp lint` type-aware en **4,2 s**, exit 0.
Le binaire `tsgolint.exe` était bien présent et s'exécutait directement sans problème dans
les deux cas.

Conséquences : ne pas conclure à une incompatibilité Vite+/Stryker en voyant cette erreur ;
côté CI Linux, sans objet ; côté poste Windows, documenter `LongPathsEnabled=1` ou un
chemin de checkout court (`C:\src\<projet>`).

## Ce que je n'ai pas pu vérifier

- **Pourquoi** `@stryker-mutator/vitest-runner@10.0.0` échoue avec `vitest@5.x`. Le symptôme
  est reproduit et isolé (A/B sur deux projets), la cause interne ne l'est pas. Aucun issue
  upstream consulté : `gh` n'est pas installé sur ce poste.
- **Si et quand** le support de Vitest 5 arrivera dans le runner Stryker. Tant que ce n'est
  pas su, la CI **doit** asserter le score de mutation attendu sur un cas témoin, sinon la
  régression « 0 % en silence » repassera inaperçue.
- **`typescriptChecker.experimentalNativePreview`** (TypeScript 7 via l'alias
  `@typescript/native`) : lu dans le schéma, jamais exécuté.
- **Le surcoût réel du checker TypeScript** sur un dépôt de taille réaliste. Le +5 s mesuré
  vaut pour 1 fichier et 11 mutants ; l'extrapoler serait une invention.
- **`incremental` / `incrementalFile`** : repris tels quels des faits projet, pas re-testés
  dans ce spike.
- **La doc officielle Vite+** (`viteplus.dev/llms-full.txt`) ne couvre ni la forme des règles
  oxlint, ni les seuils de couverture, ni le mode par défaut de `vp fmt`. Tout ce qui est
  affirmé ici sur ces trois points vient de `--help`, de `--init` et de runs réels, pas des
  docs.
- **Vite+ reste en bêta en 0.3.3.** Ces conclusions sont datées de cette version ; la
  contrainte « vitest = version embarquée par Vite+ » devra être revérifiée à chaque montée
  de `vite-plus`.
