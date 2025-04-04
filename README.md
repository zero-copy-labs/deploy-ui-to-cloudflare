# GitHub Action: Deploy UI to Cloudflare Pages

This action deploys your static site to Cloudflare Pages or deletes an existing deployment. It provides an easy way to integrate Cloudflare Pages deployments into your GitHub Actions workflow.

## Features

- Deploy static sites to Cloudflare Pages
- Manage deployments within projects (create, list, delete)
- Automatically clean up old deployments to prevent hitting deployment limits
- Configure custom headers for deployed sites
- Create GitHub deployments for PR previews with automatic cleanup
- Automatically comment on PRs with deployment URLs
- Works with Wrangler v4
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

### `GITHUB_TOKEN`

GitHub token for creating deployment statuses on the PR. This will add visible deployments to pull requests.
If not provided, the action will not create a GitHub deployment (no error will be thrown).
When used with `EVENT: "delete"`, this token will also deactivate any GitHub deployments for the PR.
Additionally, when provided, the action will automatically post comments on the PR with deployment URLs.

### `ENVIRONMENT_NAME`

Name of the environment for GitHub deployment. Defaults to "preview".
The full environment name will be `{ENVIRONMENT_NAME}/pr-{PR_NUMBER}`.

### `CREATE_PROJECT_IF_MISSING`

Automatically create the Cloudflare Pages project if it does not exist. Defaults to "true".
When set to "true", the action will create the project if it doesn't exist before attempting to deploy.
Set to "false" if you want the action to fail when the project doesn't exist.

### `CLEANUP_OLD_DEPLOYMENTS`

Clean up old deployments to avoid hitting the deployment limit. Defaults to "false".
When set to "true", the action will clean up old deployments after creating a new one.

### `DEPLOYMENT_PREFIX`

Prefix to match when cleaning up or deleting deployments. Defaults to empty string.
When provided with `EVENT: "delete"`, only deployments that match this prefix will be deleted.
Recommended format: `pr-{PR_NUMBER}` to target deployments for specific PRs.

### `KEEP_DEPLOYMENTS`

Number of deployments to keep when cleaning up. Defaults to "5".
Only the most recent deployments matching the prefix will be kept, older ones will be deleted.

## Outputs

### `url`

The URL of the deployed site (only available when EVENT is "deploy").

## Example usage

### Deploy to Cloudflare Pages with GitHub Deployment and Deployment Management

```yaml
name: Deploy PR Preview

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      deployments: write
      pull-requests: write
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
          BRANCH: ${{ github.event.pull_request.head.ref }}
          EVENT: 'deploy'
          HEADERS: '{"version.json":{"cacheControl":"max-age=0,no-cache,no-store,must-revalidate"}}'
          GITHUB_TOKEN: ${{ github.token }}
          ENVIRONMENT_NAME: 'preview'
          CLEANUP_OLD_DEPLOYMENTS: 'true'
          DEPLOYMENT_PREFIX: 'pr-${{ github.event.pull_request.number }}'
          KEEP_DEPLOYMENTS: '10'
      
      - name: Output deployment URL
        run: echo "Deployed to ${{ steps.deployment.outputs.url }}"
```

### Standard Deployment Without GitHub Deployments

```yaml
name: Deploy to Production

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

### Delete Specific Deployments for a PR

```yaml
name: Cleanup PR Preview

on:
  pull_request:
    types: [closed]

jobs:
  cleanup:
    runs-on: ubuntu-latest
    permissions:
      deployments: write
      pull-requests: write
    steps:
      - name: Extract PR Information
        id: pr-info
        run: |
          PR_NUMBER=${{ github.event.pull_request.number }}
          echo "DEPLOYMENT_PREFIX=pr-${PR_NUMBER}" >> $GITHUB_ENV

      - name: Delete Deployments and Deactivate GitHub Deployment
        uses: zero-copy-labs/deploy-ui-to-cloudflare@v1
        with:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PROJECT_NAME: 'my-project'
          DIST_FOLDER: '.'  # Not used for delete but required
          EVENT: 'delete'
          GITHUB_TOKEN: ${{ github.token }}
          ENVIRONMENT_NAME: 'preview'
          DEPLOYMENT_PREFIX: ${{ env.DEPLOYMENT_PREFIX }}
```

## Troubleshooting

### Common issues:

1. **Authentication errors**: Make sure your `CLOUDFLARE_API_TOKEN` has the correct permissions and is valid.

2. **Project not found**: Verify that the `PROJECT_NAME` exists in your Cloudflare account.

3. **Deployment failures**: Check if your build output in `DIST_FOLDER` is correct and contains all necessary files for your site.

4. **Headers not applied**: Verify that your `HEADERS` JSON is valid and properly formatted.

5. **GitHub deployments not showing**: Ensure your workflow has the `deployments: write` permission.

6. **PR comments not showing**: Ensure your workflow has the `pull-requests: write` permission.

7. **"Too many deployments" error**: This action now handles the "too many deployments" error by allowing selective cleanup of old deployments. Use the `CLEANUP_OLD_DEPLOYMENTS` flag and `DEPLOYMENT_PREFIX` to manage deployments efficiently without hitting Cloudflare's limits.

## License

MIT