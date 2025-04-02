# GitHub Action: Deploy UI to Cloudflare Pages

This action deploys your static site to Cloudflare Pages or deletes an existing deployment. It provides an easy way to integrate Cloudflare Pages deployments into your GitHub Actions workflow.

## Features

- Deploy static sites to Cloudflare Pages
- Delete existing Cloudflare Pages projects
- Configure custom headers for deployed sites
- Works with Wrangler v3
- Returns the deployment URL

## Inputs

### `CLOUDFLARE_API_TOKEN`

**Required** Cloudflare API token with Pages permissions. To create a token:
1. Go to your Cloudflare dashboard
2. Navigate to Account > My Profile > API Tokens
3. Create a token with the "Edit Cloudflare Pages" permission

### `CLOUDFLARE_ACCOUNT_ID`

**Required** Your Cloudflare account ID. Can be found in the dashboard URL: `https://dash.cloudflare.com/<account-id>`

### `DIST_FOLDER`

**Required** Path to the distribution folder that will be deployed (e.g. `dist`, `build`, `public`).

### `PROJECT_NAME`

**Required** Cloudflare Pages project name. This should match an existing Pages project.

### `BRANCH`

Branch to deploy to. Defaults to "main". This affects the URL of your deployment if you're using branch deployments.

### `EVENT`

Action to perform, either "deploy" or "delete". Defaults to "deploy".

### `HEADERS`

JSON string of custom headers configuration. Defaults to empty object.

Example:
```json
{"version.json":{"cacheControl":"max-age=0,no-cache,no-store,must-revalidate"}}
```

## Outputs

### `url`

The URL of the deployed site (only available when EVENT is "deploy").

## Example usage

### Deploy to Cloudflare Pages

```yaml
name: Deploy to Cloudflare Pages

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '16'

      - name: Install dependencies
        run: npm ci

      - name: Build site
        run: npm run build

      - name: Deploy to Cloudflare Pages
        uses: zero-copy-labs/deploy-ui-to-cloudflare@v1
        id: deployment
        with:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          DIST_FOLDER: 'dist'
          PROJECT_NAME: 'my-project'
          BRANCH: 'main'
          EVENT: 'deploy'
          HEADERS: '{"version.json":{"cacheControl":"max-age=0,no-cache,no-store,must-revalidate"}}'
      
      - name: Output deployment URL
        run: echo "Deployed to ${{ steps.deployment.outputs.url }}"
```

### Delete a deployment

```yaml
name: Cleanup Cloudflare Pages Project

on:
  workflow_dispatch:

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Delete Cloudflare Pages deployment
        uses: zero-copy-labs/deploy-ui-to-cloudflare@v1
        with:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PROJECT_NAME: 'my-project'
          DIST_FOLDER: '.'  # Not used for delete but required
          EVENT: 'delete'
```

## Troubleshooting

### Common issues:

1. **Authentication errors**: Make sure your `CLOUDFLARE_API_TOKEN` has the correct permissions and is valid.

2. **Project not found**: Verify that the `PROJECT_NAME` exists in your Cloudflare account.

3. **Deployment failures**: Check if your build output in `DIST_FOLDER` is correct and contains all necessary files for your site.

4. **Headers not applied**: Verify that your `HEADERS` JSON is valid and properly formatted.

## License

MIT
