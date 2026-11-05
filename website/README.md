# FINOS Workspace documentation site

This website was created with Docusaurus 3, and it renders the pages in `docs/`.

- `website/` holds the Node and React code that builds the site.
- `website/docusaurus.config.ts` holds the Docusaurus configuration.
- `website/static/` holds images and other static assets, which the site serves from its root.
- `docs/` holds the Markdown and MDX pages. Their folders and file names give the pages their addresses.

## Local run

The site needs Node 26.12.1, the version that the repository's images run, and Docker, which runs the backend's exporter.

```bash
cd website
npm ci --ignore-scripts
npm run reference
npm start
```

The reference pages are generated from data that the backend, the agent and the web app write. Git does not track that data, and `npm run reference` writes it. For the backend, it builds the image of the local stack with `docker compose build init` and runs the exporter in a container of that image, with the backend's folder mounted, so the exporter runs the current code with the dependencies of `poetry.lock` and nothing has to be installed or activated on your machine. For the agent and the web app, it runs `npm ci` in `agent` and in `frontend`, which replaces their `node_modules`. The page *How to regenerate the reference data* describes each part. `npm start` serves the site at `http://localhost:3100`, a port that the local stack does not use, so both can run at the same time. Run `npm run typecheck`, `npm test` and `npm run build` before you push. The build fails on a broken link or anchor.

The bundler writes the files that it reads into a folder that it generates, and those files hold the absolute paths of the machine that wrote them, so a run that reads the files of another run cannot resolve them and every page fails to compile. The site therefore keeps the files of the development server in `website/.docusaurus-dev` and the files of the build in `website/.docusaurus`, and the build removes its own folder before it starts. A container that runs the site needs the same care: give it `DOCUSAURUS_GENERATED_FILES_DIR_NAME` with a path outside the mounted folder, such as `/tmp/docusaurus`, and `DOCUSAURUS_NO_PERSISTENT_CACHE=1`, or it writes the paths of the container into the checkout, and the host cannot resolve them. The Docs workflow does this for the build that it runs in a container.

## Deployment

Netlify serves the site, as it does for FINOS websites, but the Docs workflow in `.github/workflows/docs.yml` builds it, because the reference pages need the data that the backend, the agent and the web app write. For every pull request, the workflow writes that data, generates the site, checks its types, runs the tests of its code, builds it and checks that it wrote `llms.txt`. For a pull request into `main`, a last job also publishes a draft of the built site to Netlify, so that a broken deploy stops the merge. When a change reaches `main`, the same jobs run, and the last job publishes the built site to Netlify with the Netlify CLI. The workflow reads the secret `NETLIFY_AUTH_TOKEN`, which is a Netlify access token that may deploy the site, and the secret `NETLIFY_SITE_ID`, which is the site's ID. The file `netlify.toml` at the root of the repository makes Netlify's own builder skip every build, so that the workflow is the only way the site changes. The build writes `llms.txt` at the root of the site, with the title, address and description of every page; the plugin `plugins/llms.ts` writes it. To serve the site at an address such as `<project>.finos.org`, email help@finos.org.

## Website dependency updates

The file `osv-scanner.toml` excludes the website's dependencies from OSV scans, because the website is never shipped to users. Delete the file to include them, which FINOS does not recommend. Docusaurus patches often arrive weeks or months after the vulnerable dependencies are found, so automated tools such as Dependabot cannot fix them quickly.
