# GitHub Action: Deploy UI to Cloudflare Pages

This action deploys your static site to Cloudflare Pages or deletes an existing deployment.

## Inputs

### `CLOUDFLARE_API_TOKEN`

**Required** Cloudflare API token with Pages permissions.

### `CLOUDFLARE_ACCOUNT_ID`

**Required** Cloudflare account ID.

### `DIST_FOLDER`

**Required** Path to the distribution folder that will be deployed.

### `PROJECT_NAME`

**Required** Cloudflare Pages project name.

### `BRANCH`

Branch to deploy to. Defaults to "main".

### `EVENT`

Action to perform, either "deploy" or "delete". Defaults to "deploy".

### `HEADERS`

JSON string of custom headers configuration. Defaults to empty object.

## Outputs

### `url`

The URL of the deployed site (only available when EVENT is "deploy").

## Example usage

### Deploy to Cloudflare Pages

```yaml
- name: Deploy to Cloudflare Pages
  uses: zero-copy-labs/deploy-ui-to-cloudflare@v1
  with:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    DIST_FOLDER: 'dist'
    PROJECT_NAME: 'my-project'
    BRANCH: 'main'
    EVENT: 'deploy'
    HEADERS: '{"version.json":{"cacheControl":"max-age=0,no-cache,no-store,must-revalidate"}}'
```

### Delete a deployment

```yaml
- name: Delete Cloudflare Pages deployment
  uses: zero-copy-labs/deploy-ui-to-cloudflare@v1
  with:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    PROJECT_NAME: 'my-project'
    EVENT: 'delete'
```
