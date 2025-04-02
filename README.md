# Action to reset a Supabase Database 

## Inputs

### `connectionString`

**Required** e.g. `postgres://user:password@host:5432/database`.

### `users`

e.g. `user@test.com,user2@test.com`.

### `buckets`

e.g. `public,content`.

### `extensions`

e.g. `content-lib,welcome`.

## Example usage

```yaml
uses: zero-copy-labs/reset-supabase-database@main
with:
  connectionString: 'postgres://user:password@host:5432/database'
  users: 'user@test.com,user2@test.com'
  buckets: 'public,content'
  extensions: 'content-lib,welcome'
```
