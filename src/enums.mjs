import * as core from '@actions/core';
import { forEachSeries } from 'modern-async';

const enums = `select nums.enum_name from (
select n.nspname as enum_schema,  
       t.typname as enum_name,  
       e.enumlabel as enum_value
from pg_type t 
   join pg_enum e on t.oid = e.enumtypid  
   join pg_catalog.pg_namespace n ON n.oid = t.typnamespace
where n.nspname = 'public'
) as nums
GROUP BY nums.enum_name;
`

async function dropType(name, c) {
	core.info(`Drop Type : ${name}`);

	return c.query(`DROP TYPE IF EXISTS "${name}" CASCADE;`)
}

export default async function run(c) { 
	// Find all Enums  in the public schema
	const { rows: nums } = await c.query(enums)
	
	// Delete all the included enums 
	await forEachSeries(nums, async (num) => {
		return dropType(num.enum_name, c);
	})
}