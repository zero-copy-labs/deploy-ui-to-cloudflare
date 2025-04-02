import * as core from '@actions/core';
import { forEachSeries } from 'modern-async';

const tablesAndViews = `
SELECT table_name, table_type FROM information_schema.tables 
WHERE table_schema = 'public';
`;

const materializedViews = `select schemaname as schema_name,
       matviewname as view_name,
       matviewowner as owner,
       ispopulated as is_populated,
       definition
from pg_matviews
where schemaname = 'public'
order by schema_name,
         view_name;
`;

async function dropMaterializedView(name, c) {
	core.info(`Drop Materialized View: ${name}`);

	return c.query(`DROP MATERIALIZED VIEW IF EXISTS "${name}" CASCADE;`)
}

async function dropView(name, c) {
	core.info(`Drop View: ${name}`);

	return c.query(`DROP VIEW IF EXISTS "${name}" CASCADE;`)
}

async function dropTable(name, c) {
	core.info(`Drop Table: ${name}`);

	return c.query(`DROP TABLE IF EXISTS "${name}" CASCADE;`)
}

export default async function run(c) {
	// Find all materialized views in the public schema
	const { rows: mViews }= await c.query(materializedViews)

	await forEachSeries(mViews, async (view) => {
		return dropMaterializedView(view.view_name, c);
	})

	// Find all tables and views in the public schema
	const { rows: tables }= await c.query(tablesAndViews)

	// Delete them tables or views
	await forEachSeries(tables, async (table) => {
		if(table.table_type === 'VIEW') {
			return dropView(table.table_name, c);
		}
		return dropTable(table.table_name, c);
	})
}