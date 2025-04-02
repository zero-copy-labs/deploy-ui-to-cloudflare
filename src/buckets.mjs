import * as core from '@actions/core';
import { forEachSeries } from 'modern-async';

async function deleteBucket(id, c) {
    core.info(`Delete Bucket: ${id}`);

    const u = await c.query(`SELECT id FROM "storage"."buckets" WHERE id = '${id}';`)
    if(u.rows.length > 0) {
        core.info(`Found Bucket: ${id} deleting...`);
        await c.query(`DELETE FROM "storage"."objects" WHERE bucket_id = '${id}';`)
        return c.query(`DELETE FROM "storage"."buckets" WHERE id = '${id}';`)
    }
    core.info(`Delete Bucket: ${id} not found, skipping...`);
    return true;
}

export default async function run(buckets, c) { 
	await forEachSeries(buckets, async (bucket) => {
        return deleteBucket(bucket, c);
    })
}