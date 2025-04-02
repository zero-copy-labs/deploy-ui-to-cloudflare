import * as core from '@actions/core';

export default async function run(c) {
	// Clear the migrations table
	core.info('Clearing supabase migrations');
	await c.query(`TRUNCATE "supabase_migrations"."schema_migrations";`);
}