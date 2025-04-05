# GitHub Action: Deploy UI to Cloudflare Pages

This action deploys your static site to Cloudflare Pages or deletes an existing deployment. It provides an easy way to integrate Cloudflare Pages deployments into your GitHub Actions workflow.

## Features

- Deploy static sites to Cloudflare Pages
- Delete existing Cloudflare Pages projects
- Configure custom headers for deployed sites
- Create GitHub deployments for PR previews with automatic cleanup
- **Automatically comment on PRs with deployment URLs**
- **Add cleanup notifications to PRs when deployments are removed**
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

GitHub token for creating deployment statuses on the PR and adding comments. This will add visible deployments to pull requests.
If not provided, the action will not create a GitHub deployment or comments (no error will be thrown).
When used with `EVENT: "delete"`, this token will also deactivate any GitHub deployments for the PR.

### `ENVIRONMENT_NAME`

Name of the environment for GitHub deployment. Defaults to "preview".
The full environment name will be `{ENVIRONMENT_NAME}/pr-{PR_NUMBER}`.

### `COMMENT_ON_PR`

Whether to automatically comment on the PR with the deployment URL. Defaults to "false".
When set to "true" and `GITHUB_TOKEN` is provided, a comment with the deployment URL will be added to the PR.

### `COMMENT_ON_PR_CLEANUP`

Whether to automatically comment on the PR when the deployment is cleaned up. Defaults to "false".
When set to "true" and `GITHUB_TOKEN` is provided, a cleanup notification comment will be added to the PR.

### `PR_NUMBER`

Pull request number for PR-specific deployments and comments. If not provided, the action will try to get it from the GitHub context.

## Outputs

### `url`

The URL of the deployed site (only available when EVENT is "deploy").

## Example usage

### Deploy to Cloudflare Pages with Automatic PR Comments

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
          PR_NUMBER: ${{ github.event.pull_request.number }}
          COMMENT_ON_PR: 'true'  # Will automatically add a comment with the deployment URL
      
      - name: Output deployment URL
        run: echo "Deployed to ${{ steps.deployment.outputs.url }}"
```

The action will automatically add a comment like this to your PR:

```
🚀 PR Preview deployed to: https://branch-name.my-project.pages.dev
```

### Delete a deployment with automatic PR cleanup comment

```yaml
name: Cleanup Cloudflare Pages Project

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
      - name: Delete Cloudflare Pages deployment
        uses: zero-copy-labs/deploy-ui-to-cloudflare@v1
        with:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PROJECT_NAME: 'my-project'
          DIST_FOLDER: '.'  # Not used for delete but required
          EVENT: 'delete'
          GITHUB_TOKEN: ${{ github.token }}  # For deactivating GitHub deployments and commenting
          ENVIRONMENT_NAME: 'preview'
          PR_NUMBER: ${{ github.event.pull_request.number }}
          COMMENT_ON_PR_CLEANUP: 'true'  # Will automatically add a cleanup notification comment
```

The action will automatically add a comment like this to your PR:

```
🧹 PR Preview environment has been cleaned up.
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

## Troubleshooting

### Common issues:

1. **Authentication errors**: Make sure your `CLOUDFLARE_API_TOKEN` has the correct permissions and is valid.

2. **Project not found**: Verify that the `PROJECT_NAME` exists in your Cloudflare account.

3. **Deployment failures**: Check if your build output in `DIST_FOLDER` is correct and contains all necessary files for your site.

4. **Headers not applied**: Verify that your `HEADERS` JSON is valid and properly formatted.

5. **GitHub deployments not showing**: Ensure your workflow has the `deployments: write` permission.

6. **PR comments not working**: Make sure your workflow has the `pull-requests: write` permission and that you've provided a valid `GITHUB_TOKEN`.

## License

MIT