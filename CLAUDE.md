# Ardoise

Pay anyone, on any chain, with your bitcoin without selling it: each payment borrows exactly the amount on Arc at the best available rate, and your position is protected from liquidation.

Built for **UBC Hackathon 2026 (University Blockchain Conference, UT Austin)** (submission deadline: 2026-11-20 12:00 CST (UTC-6)), targeting: DeFi & Onchain Apps, Best use of Arc.

## Project context

The full project brief lives outside this repository, in the team's Obsidian vault:
`/Users/enzoblain/Obsidian/Hackathons/Événements/2026-11-20 UBC/Projet.md`

Read it at the start of every session. It defines the scope, the work plan, the demo script, the submission checklist and the decision log. The vault notes are written in French; everything written in this repository must be in English. When a decision changes the scope, the stack or the targeted tracks, tell the user so the note can be updated.

The task breakdown for the hackathon (who does what, when, on which branch) is in this repository: [`docs/roadmap.md`](docs/roadmap.md). Read it at the start of every session too, and work only on the task you were given there. When a task changes status, update its row in `docs/roadmap.md` in the same pull request. It is not the README *Roadmap* section, which describes what would come after the hackathon.

## Stack and commands

- Stack: Solidity (Foundry) on Arc mainnet (chain id 5042), Aave V4 and Morpho as lending venues, Circle CCTP / Gateway, Next.js + viem front end, Node keeper
- Prerequisites: Node.js 22.9+, npm, Foundry (`foundryup`); clone with `--recurse-submodules` (or run `git submodule update --init`)
- Install: `cd app && npm install`, `cd keeper && npm install` (contracts need no install beyond the submodule)
- Run: `cd app && npm run dev` (front end on http://localhost:3000), `cd keeper && npm start` (keeper); both read the repo-root `.env`, Foundry does not (`set -a && source .env && set +a` first)
- Test: `cd contracts && forge build && forge test`, `cd app && npm run lint && npm run build`, `cd keeper && npm run typecheck`

## Rules for every agent working in this repository

### Language

Everything in the repository is written in **English**: code, identifiers, comments, commit messages, documentation, README, issues and pull requests. No French, even in temporary code.

### Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/). A `commit-msg` hook in `.githooks/` rejects any message that does not.

```
<type>(<optional scope>): <subject>

<optional body: what changed and why, wrapped at 72 characters>
```

- **Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **Subject:** imperative mood ("add", not "added" or "adds"), lowercase first letter, no trailing period, 72 characters maximum.
- **One logical change per commit.** Do not mix a feature, a refactor and a formatting pass in one commit.
- Commit working states often; every commit must build.
- Never bypass the hooks with `--no-verify`. If a hook blocks a commit by mistake, tell the user instead of working around it.

Examples:
```
feat(wallet): add session key signing for agent payments
fix(api): handle expired nonce on settlement retry
docs(readme): document local testnet setup
```

### Branches and pull requests

**Never commit or push to `main`.** The `pre-commit` hook blocks commits on `main` and the `pre-push` hook blocks pushes to it. `main` changes only through reviewed pull requests.

1. **Start every task on a new branch** from an up-to-date `main`:
   ```
   git switch main && git pull && git switch -c <type>/<short-topic>
   ```
   Branch names are lowercase, `<type>/<topic>` or `<type>-<topic>`, with the commit types plus `dev` and `hotfix`: `feat/session-keys`, `fix/expired-nonce`, `docs/readme-setup`, `dev/enzo`. The hook rejects other names.
2. **One branch per unit of work**, sized by the process level below: a small task at the `full` level, a whole feature at the `light` level. Do not mix unrelated changes.
3. **Open a pull request** when the task is done and the build and tests pass:
   ```
   git push -u origin HEAD
   gh pr create --base main --title "<conventional commit title>" --body "<summary>"
   ```
   - The title follows Conventional Commits, since it becomes the commit message on `main` when squash-merged.
   - The body explains what changed and why, how it was tested, which docs were updated, and links any issue.
4. **Get a review from a separate agent in review mode** when the process level below requires one. The agent that wrote the code never reviews its own pull request.
   - In Claude Code, run `/code-review --comment <PR number>` (or `/code-review <PR number>` and post the result) from a **new session**, not the one that wrote the code.
   - If that command is not available, start a fresh agent whose only instructions are: review this pull request diff (`gh pr diff <number>`) against this `CLAUDE.md`, find bugs, security issues and rule violations, and post the findings with `gh pr review <number> --comment`.
   - The review covers correctness, security and secrets, the rules in this file (language, commits, hygiene, comments) and whether the README and docs match the change.
5. **Fix every blocking finding** with new commits on the same branch, push, and request a new review. Repeat until the latest review has no blocking finding.
6. **Merge only with the user's go-ahead**, using squash merge (`gh pr merge <number> --squash --delete-branch`). Never merge your own pull request on your own initiative.

If several agents work in parallel, each one has its own branch; rebase on `main` before opening the pull request and resolve conflicts on the branch, never on `main`.

### Process level

This project runs at the **full** level, chosen from the hackathon's length, the team size and the Claude quota available. Reviews cost quota and time; the level keeps them where they matter.

**`full`** (longer hackathon, a team, or several Claude accounts working in parallel)
- One branch and one pull request per task.
- Every pull request is reviewed by a separate agent, and every review thread must be resolved before merging (GitHub enforces it).

### Crunch mode

Crunch mode starts at **2026-11-20 00:00 CST (UTC-6)** and the merge freeze at **2026-11-20 11:30 CST (UTC-6)**, before the submission deadline of **2026-11-20 12:00 CST (UTC-6)**. At the start of every session, check the current time (`date`) against these times.

During crunch mode, whatever the process level:
- **No new features and no refactoring.** Only fixes to the demo path, submission deliverables (video, README, submission text) and documentation.
- Work on `hotfix/<topic>` branches with small pull requests.
- **Review:** a quick review by a fresh agent, limited to bugs that would break the demo and to secrets. If there is not enough time, the user's explicit approval replaces it.
- Review comments that do not block the demo get a reply ("Deferred until after the hackathon") and their thread is resolved, so they do not block the merge.
- The secret and hygiene hooks still apply. Never use `--no-verify`, never push to `main`.

During the **merge freeze**, nothing is merged unless the user explicitly asks for that specific change. Use the remaining time to check that the deployed app, the video and the submission form are in order.

### Secrets and production

A `pre-commit` hook in `.githooks/` blocks environment files, key material and common secret patterns, but it cannot catch everything. These rules apply even where the hook is silent.

- Secrets (API keys, private keys, seed phrases, tokens, passwords, RPC URLs with embedded keys) live **only in environment variables**. Never in code, tests, fixtures, docs, comments, commit messages, logs or screenshots.
- Every variable is listed in `.env.example` with an empty or dummy value and a comment explaining it.
- **Nothing secret in the frontend.** Variables exposed to the browser (`NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*`, `PUBLIC_*`) ship to every visitor. Anything that must stay private goes through a server-side route.
- **Production secrets** are set in the hosting platform's secret manager (Vercel, Railway, Fly, GitHub Actions secrets...), never in a committed config file. Use separate keys for development and production.
- **Wallets:** use a dedicated wallet created for this project, on testnet whenever possible, holding only the funds the demo needs. Never use the user's or a teammate's personal wallet.
- Never log secrets or full request headers; redact them in error messages.
- Lock down production endpoints: no debug routes, no admin endpoints without authentication, no permissive CORS (`*`) on routes that use secrets, rate limits on anything that spends money (LLM calls, transactions).
- **If a secret is committed or exposed, stop and tell the user immediately.** The key must be revoked and rotated; removing it from the history is not enough once it has been pushed.
- A known false positive (for example a public, documented test key) can be allowed with a trailing `secret-scan:allow` comment on that line, and only with the user's approval.

### Repository hygiene

The repository contains only what is needed to build, run, test and understand the project. Judges read it.

- No dependencies, build output, caches, logs, coverage reports, OS or editor files. They belong in `.gitignore`.
- No files over 5 MB (the hook blocks them). Compress images; link to videos instead of committing them.
- No scratch files: personal notes, temporary scripts, debug output, agent plans (the shared `docs/roadmap.md` is the only plan kept in the repository), `test.js`, `old_*`, `*_copy`, `*_v2`, backup files. Delete them before committing.
- No dead code: remove unused files, functions, dependencies and commented-out blocks instead of leaving them.
- No unused boilerplate from templates or scaffolding (default logos, sample pages, placeholder tests).
- Keep a clear folder structure, described in the README.

### Code comments

- Comments explain **why**, not what: intent, constraints, non-obvious decisions, workarounds for known SDK issues (with a link to the issue).
- No commented-out code, no vague `TODO`. A `TODO` must say what is missing and why it is deferred.
- Public functions, classes and modules have a docstring (or the language's equivalent: JSDoc, rustdoc, NatSpec...) describing purpose, parameters, return value and errors.

### Documentation stays current

Documentation is updated **in the same pull request as the change it describes**, never "later" and never in a separate cleanup at the end. A pull request that changes behavior without updating the matching docs is incomplete, and the reviewer must flag it.

Before opening a pull request, check each of these against your change:

| If your change... | Update |
|---|---|
| adds or changes a user-facing feature | README: *The solution*, *Demo* screenshots if the UI changed |
| changes the architecture, a component or a data flow | README: *How it works* diagram, and `docs/architecture.md` |
| adds, removes or changes how a sponsor technology is used | README: *Built with* section, with links to the files |
| changes setup, commands, dependencies or prerequisites | README: *Getting started*, and the commands in this `CLAUDE.md` |
| adds or renames an environment variable | `.env.example` |
| adds, moves or removes a top-level folder | README: *Project structure* |
| changes a public function, API route or contract interface | its docstring, and `docs/api.md` if it exists |
| finishes or drops a planned item | README: *Roadmap* |

- Documentation follows all the other rules: English, professional tone, no secrets, nothing the code does not actually do.
- Docs may go in the same commit as the code, or in a `docs(<scope>): ...` commit on the same branch.
- Architecture notes that do not fit in the README go in `docs/`, with diagrams in Mermaid.
- Never describe a feature in the README before it works.

### README structure

1. **Title and one-line pitch**, followed by badges if relevant (license, build, deployed demo).
2. **Demo**: link to the live app and the demo video, and one or two screenshots or a GIF.
3. **The problem**: who has it and why it matters, in a short paragraph.
4. **The solution**: what the project does, from the user's point of view.
5. **How it works**: architecture overview, with a Mermaid diagram.
6. **Built with Circle and Arc**: exactly where and how each sponsor technology is used, with links to the relevant files. Judges look for this.
7. **Getting started**: prerequisites, installation and run instructions that work in under 2 minutes on a clean machine.
8. **Project structure**: short tree of the main folders.
9. **Roadmap**: what would come after the hackathon.
10. **Team**: names, roles and links.
11. **License**.

Tone: concise, factual, professional. No marketing superlatives, no emoji in headings, no claims the code does not support.

## Before ending a session

- The build passes and the tests run.
- No scratch files, debug output or dead code is left behind.
- No secret was added outside environment variables.
- The README and docs reflect the change (see the table above).
- All changes are committed with conventional messages on a task branch, never on `main`.
- If the task is done: the branch is pushed, a pull request is open, and a review by a separate agent has been requested when the process level (or crunch mode) requires one.
