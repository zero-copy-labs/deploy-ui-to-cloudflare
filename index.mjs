import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Main function to run the action
 */
async function run() {
  try {
    // Get inputs
    const cloudflareApiToken = core.getInput('CLOUDFLARE_API_TOKEN', { required: true });
    const cloudflareAccountId = core.getInput('CLOUDFLARE_ACCOUNT_ID', { required: true });
    const distFolder = core.getInput('DIST_FOLDER', { required: true });
    const projectName = core.getInput('PROJECT_NAME', { required: true });
    const branch = core.getInput('BRANCH') || 'main';
    const event = core.getInput('EVENT') || 'deploy';
    const headers = core.getInput('HEADERS') || '{}';

    // Validate input
    if (event !== 'deploy' && event !== 'delete') {
      throw new Error('EVENT must be either "deploy" or "delete"');
    }

    // Set environment variables for Cloudflare
    process.env.CLOUDFLARE_API_TOKEN = cloudflareApiToken;
    process.env.CLOUDFLARE_ACCOUNT_ID = cloudflareAccountId;

    // Log what we're about to do
    if (event === 'deploy') {
      core.info(`Deploying ${distFolder} to Cloudflare Pages project "${projectName}" on branch "${branch}"`);
      
      // Check if dist folder exists
      try {
        await fs.access(distFolder);
      } catch (error) {
        throw new Error(`Distribution folder "${distFolder}" does not exist`);
      }

      // Process custom headers if provided
      try {
        const headersObj = JSON.parse(headers);
        if (Object.keys(headersObj).length > 0) {
          core.info('Processing custom headers configuration');
          const headersFilePath = path.join(distFolder, '_headers.json');
          await fs.writeFile(headersFilePath, headers);
          core.info(`Custom headers written to ${headersFilePath}`);
        }
      } catch (error) {
        core.warning(`Error processing headers: ${error.message}`);
      }

      // Deploy to Cloudflare Pages
      let deployOutput = '';
      const options = {
        listeners: {
          stdout: (data) => {
            deployOutput += data.toString();
          }
        }
      };

      await exec.exec('npx', ['wrangler@2', 'pages', 'publish', distFolder, '--project-name', projectName, '--branch', branch], options);

      // Extract URL from output
      const urlMatch = deployOutput.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        const deployUrl = urlMatch[0];
        core.info(`Deployment successful: ${deployUrl}`);
        core.setOutput('url', deployUrl);
      } else {
        core.warning('Could not extract deployment URL from output');
      }
    } else if (event === 'delete') {
      core.info(`Deleting Cloudflare Pages deployment for project "${projectName}"`);
      
      // Delete from Cloudflare Pages
      await exec.exec('npx', ['wrangler@2', 'pages', 'project', 'delete', projectName, '--yes']);
      
      core.info(`Successfully deleted project "${projectName}"`);
    }

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
