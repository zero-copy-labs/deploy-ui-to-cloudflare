import * as core from '@actions/core';
import * as exec from '@actions/exec';
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

    // Validate inputs
    if (!cloudflareApiToken || !cloudflareAccountId || !projectName) {
      throw new Error('Required inputs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and PROJECT_NAME must be non-empty');
    }

    if (event !== 'deploy' && event !== 'delete') {
      throw new Error('EVENT must be either "deploy" or "delete"');
    }

    // Set environment variables for Cloudflare
    // Mask the token in logs
    core.setSecret(cloudflareApiToken);
    process.env.CLOUDFLARE_API_TOKEN = cloudflareApiToken;
    process.env.CLOUDFLARE_ACCOUNT_ID = cloudflareAccountId;

    if (event === 'deploy') {
      await deployToCloudflare(distFolder, projectName, branch, headers);
    } else {
      await deleteFromCloudflare(projectName);
    }

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

/**
 * Deploy to Cloudflare Pages
 */
async function deployToCloudflare(distFolder, projectName, branch, headersJson) {
  core.info(`Deploying ${distFolder} to Cloudflare Pages project "${projectName}" on branch "${branch}"`);
  
  // Check if dist folder exists
  try {
    await fs.access(distFolder);
  } catch (error) {
    throw new Error(`Distribution folder "${distFolder}" does not exist or is not accessible`);
  }

  // Process custom headers if provided
  try {
    const headersObj = JSON.parse(headersJson);
    if (Object.keys(headersObj).length > 0) {
      core.info('Processing custom headers configuration');
      const headersFilePath = path.join(distFolder, '_headers.json');
      await fs.writeFile(headersFilePath, headersJson);
      core.info(`Custom headers written to ${headersFilePath}`);
    }
  } catch (error) {
    core.warning(`Error processing headers: ${error.message}. Continuing without custom headers.`);
  }

  // Deploy to Cloudflare Pages
  let deployOutput = '';
  let errorOutput = '';
  
  const options = {
    listeners: {
      stdout: (data) => {
        const chunk = data.toString();
        deployOutput += chunk;
        // Log output in chunks for better visibility
        if (chunk.trim()) core.info(chunk.trim());
      },
      stderr: (data) => {
        const chunk = data.toString();
        errorOutput += chunk;
        // Log errors in chunks
        if (chunk.trim()) core.warning(chunk.trim());
      }
    }
  };

  try {
    // Using wrangler v3 instead of v4 for Node.js 16 compatibility
    await exec.exec('npx', ['wrangler@3', 'pages', 'deploy', distFolder, '--project-name', projectName, '--branch', branch], options);
  } catch (error) {
    throw new Error(`Wrangler deployment failed: ${errorOutput || error.message}`);
  }

  // Extract URL from output using a more reliable approach
  // Look for "View your deployed site at: https://..." or similar patterns
  const urlRegex = /(?:View your deployed site at|Successfully deployed to|Preview URL)[:\s]+(\bhttps?:\/\/[^\s]+\b)/i;
  const match = deployOutput.match(urlRegex);
  
  if (match && match[1]) {
    const deployUrl = match[1].trim();
    core.info(`Deployment successful: ${deployUrl}`);
    core.setOutput('url', deployUrl);
  } else {
    core.warning('Could not extract deployment URL from output. Deployment might have succeeded, but no URL was found.');
    // Try to guess the URL based on project name and branch
    const guessedUrl = `https://${branch === 'main' ? '' : branch + '.'}${projectName}.pages.dev`;
    core.info(`Guessed deployment URL (may not be accurate): ${guessedUrl}`);
    core.setOutput('url', guessedUrl);
  }
}

/**
 * Delete a Cloudflare Pages deployment
 */
async function deleteFromCloudflare(projectName) {
  core.info(`Deleting Cloudflare Pages deployment for project "${projectName}"`);
  
  let errorOutput = '';
  const options = {
    listeners: {
      stderr: (data) => {
        errorOutput += data.toString();
      }
    }
  };

  try {
    // Using wrangler v3 instead of v4 for Node.js 16 compatibility
    await exec.exec('npx', ['wrangler@3', 'pages', 'project', 'delete', projectName, '--yes'], options);
    core.info(`Successfully deleted project "${projectName}"`);
  } catch (error) {
    // Check if error is because project doesn't exist
    if (errorOutput.includes('not found') || errorOutput.includes('does not exist')) {
      core.warning(`Project "${projectName}" does not exist or is already deleted.`);
    } else {
      throw new Error(`Failed to delete project: ${errorOutput || error.message}`);
    }
  }
}

run();
