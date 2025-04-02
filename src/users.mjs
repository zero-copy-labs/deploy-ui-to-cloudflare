import * as core from '@actions/core';
import { forEachSeries } from 'modern-async';

async function deleteUser(email, c) {
    core.info(`Delete User : ${email}`);

    const u = await c.query(`SELECT email FROM "auth"."users" WHERE email = '${email}';`)
    if(u.rows.length > 0) {
        core.info(`Found User : ${email} deleting...`);
        return c.query(`DELETE FROM "auth"."users" WHERE email = '${email}';`)
    }
    core.info(`Delete User: ${email} not found, skipping...`);
    return true;
}


export default async function run(users, c) { 
	await forEachSeries(users, async (user) => {
        return deleteUser(user, c);
    })
}