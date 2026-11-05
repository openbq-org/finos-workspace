# FINOS Workspace

The web application of FINOS Workspace: dashboards of widgets that read from the data backends a deployment connects, with an agent beside them. It is a React and TypeScript single-page app that talks to the FINOS Workspace backend (`backend-api/backend` in this repository).

## Tech stack

- **Framework**: React 19, TypeScript
- **Build tool**: Vite
- **Styling**: Tailwind CSS, Radix UI
- **State**: Zustand, React Query (TanStack Query)
- **Routing**: React Router
- **Forms**: React Hook Form, Zod
- **Testing**: Vitest, Playwright, MSW
- **Linting and formatting**: Biome

## Project structure

```text
src/
├── api/                    # Calls to the backend
├── components/             # React components by domain
│   ├── AI/                 # The agent
│   ├── Admin*/             # Administration: users, roles, entities
│   ├── DataConnectors/     # Connections to data backends
│   ├── ds/                 # Design system (atoms, molecules, dialogs)
│   ├── General/            # Shared UI
│   ├── LayoutAuth/         # The signed-in layout
│   ├── Settings/           # User settings
│   └── Widgets/            # Dashboard widgets
├── hooks/                  # Custom hooks
├── lib/                    # Utilities and business logic
│   ├── contexts/           # React contexts
│   ├── state/              # Zustand stores
│   └── runtimeConfig*.ts   # Configuration
├── routes/                 # Pages
├── types/                  # Shared types
└── utils/                  # Utility functions

tests/
├── unit/                   # Vitest
├── e2e/                    # Playwright, against a running stack
└── mocks/                  # MSW handlers and shared mocks
```

## Getting started

You need [Node.js](https://nodejs.org/), with the npm it ships. If you contribute code, add the [Biome](https://marketplace.visualstudio.com/items?itemName=biomejs.biome) extension to your editor.

```bash
npm install
npm run dev
```

The app starts on `http://localhost:1420` and talks to the backend named by `VITE_BACKEND_URL` in `.env` (`http://localhost:8000` unless you change it). The root `docker-compose.yml` starts the whole stack, including this app on `http://localhost:3000`.

## Configuration

Every setting, and its default, is defined in `src/lib/runtimeConfigSchema.ts`; `.env` lists them as `VITE_*` variables with a comment each. Settings that name a deployment's own services (the AI service, the documentation site, a support address, the identity providers' client IDs) are empty by default, and the parts of the interface that depend on one are hidden until it is set.

```bash
npm run build            # builds with the settings from .env baked in
npm run build:runtime    # also writes dist/config.js
npm run preview          # serves the build on http://localhost:4173
```

A runtime build loads `dist/config.js` before the app. Edit that file, or mount your own over it, to change a deployment's settings without rebuilding.

### Docker image

The `Dockerfile` builds the runtime build once, so one image runs in every environment. nginx renders `config.js` from environment variables, for example `BACKEND_URL` and `AI_API_URL`, with `app-config.js`; a setting whose variable is not set keeps its default, and an invalid value makes `config.js` and the `/healthz` check answer 500. nginx serves the app on port 8080 as an unprivileged user. The image is built from scratch: nginx is compiled in the `Dockerfile` into one static binary, with njs, PCRE2, zlib and musl, and the image holds only that binary, its configuration (`nginx.conf`) and the app, with no shell or package manager.

```bash
docker build -t workspace-frontend .
docker run --rm -p 3000:8080 -e BACKEND_URL=http://localhost:8000 workspace-frontend
```

`app-config.js` has one row per setting in `src/lib/runtimeConfigSchema.ts`, with the variable that sets it and its type (`string`, `bool`, `list` or `theme`), and `nginx.conf` passes each variable to nginx with an `env` line. Adding or removing a setting in the schema means changing both: `node scripts/check-runtime-config.ts`, which the image build runs, fails when they disagree.

nginx also sends a `Content-Security-Policy` header, which `app-config.js` builds from the same variables and from `CSP_EXTRA_SOURCES` and `CSP_REPORT_ONLY` (its `HEADER_FIELDS`). nginx drops server-level headers in a location that sets its own, so every location with an `add_header` repeats the two policy headers; `tests/unit/appConfigCsp.test.ts` checks that, and that the hash of the plugin shell in `app-config.js` matches `src/plugins/shell/shell.js`.

## Testing

```bash
npm run test:unit                    # all unit tests
npm run test:unit -- --coverage      # with a coverage report
npm run typecheck                    # tsc --noEmit
npm run test:e2e                     # Playwright, against a running stack
npx playwright test tests/e2e --ui  # Playwright with its interactive UI
```

The end-to-end tests sign in to a running stack with an account that exists there; `E2E_USER_EMAIL` and `E2E_USER_PASSWORD` name it, and `E2E_BASE_URL` (default `http://localhost:3000`) says where the stack is. [TESTING.md](./TESTING.md) has the details, along with the testing guide: patterns, mocking, and coverage.

## Adding icons

All icons live in one sprite, `public/assets/icons/sprite.svg`.

1. Get the SVG, for example from Figma or [icones.js.org](https://icones.js.org/).
2. Convert it to a `<symbol>` with an `id` that no other symbol uses (see the sprite for the existing ones), and paste it inside the `<svg>` of the sprite.
3. Run `npm run update-icons` to update the `Icon` type.
4. Use it with `<Icon id="your-id" className="w-4 h-4" />`.

## Conventions

Custom class names prefixed with an underscore (for example `_elements-left-navbar`) mark HTML elements for selectors and tests. The prefix tells them apart from the classes of frameworks and libraries.
