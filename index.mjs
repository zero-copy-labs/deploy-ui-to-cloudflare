import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import path from 'path';
import https from 'https';

/**
 * Main entry point for the action
 * Reads inputs, validates them, and calls the appropriate function based on the event type
 * @returns {Promise<void>}
 */
async function run() {
  try {
    const cloudflareApiToken = core.getInput('CLOUDFLARE_API_TOKEN', { required: true });
    const cloudflareAccountId = core.getInput('CLOUDFLARE_ACCOUNT_ID', { required: true });
    const distFolder = core.getInput('DIST_FOLDER', { required: true });
    const projectName = core.getInput('PROJECT_NAME', { required: true });
    const branch = core.getInput('BRANCH') || 'main';
    const event = core.getInput('EVENT') || 'deploy';
    const headers = core.getInput('HEADERS') || '{}';
    const githubToken = core.getInput('GITHUB_TOKEN');
    const environmentName = core.getInput('ENVIRONMENT_NAME') || 'preview';

    if (!cloudflareApiToken || !cloudflareAccountId || !projectName) {
      throw new Error('Required inputs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and PROJECT_NAME must be non-empty');
    }

    if (event !== 'deploy' && event !== 'delete') {
      throw new Error('EVENT must be either "deploy" or "delete"');
    }

    core.setSecret(cloudflareApiToken);
    if (githubToken) {
      core.setSecret(githubToken);
    }
    
    process.env.CLOUDFLARE_API_TOKEN = cloudflareApiToken;
    process.env.CLOUDFLARE_ACCOUNT_ID = cloudflareAccountId;

    if (event === 'deploy') {
      const deployUrl = await deployToCloudflare(distFolder, projectName, branch, headers);
      
      // If we have a GitHub token, create a deployment and post a comment
      if (githubToken) {
        await createGitHubDeployment(githubToken, deployUrl, environmentName);
        await commentOnPR(githubToken, deployUrl);
      } else {
        core.info('No GitHub token provided, skipping deployment status creation and PR comment');
      }
    } else {
      try {
        await deleteFromCloudflare(projectName, cloudflareApiToken, cloudflareAccountId);
      } catch (error) {
        // If the error is due to too many deployments, attempt to clean up deployments first
        if (error.message.includes('too many deployments') || error.message.includes('8000076')) {
          core.warning('Project has too many deployments. Attempting to clean up individual deployments first...');
          await cleanupDeployments(projectName, cloudflareApiToken, cloudflareAccountId);
          // Try deleting the project again
          await deleteFromCloudflare(projectName, cloudflareApiToken, cloudflareAccountId);
        } else {
          throw error;
        }
      }
      
      // If we have a GitHub token, deactivate deployments and post a cleanup comment
      if (githubToken) {
        await deactivateGitHubDeployments(githubToken, environmentName);
        await commentOnPRCleanup(githubToken);
      } else {
        core.info('No GitHub token provided, skipping deployment deactivation and PR comment');
      }
    }

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

/**
 * Make a request to the Cloudflare API
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {string} token - API token
 * @param {object} [body] - Request body for POST/PUT requests
 * @returns {Promise<object>} - Response body
 */
async function cloudflareApiRequest(method, path, token, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.cloudflare.com',
      port: 443,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsedData = JSON.parse(data);
            resolve(parsedData);
          } catch (e) {
            reject(new Error(`Failed to parse Cloudflare API response: ${e.message}`));
          }
        } else {
          reject(new Error(`Cloudflare API returned ${res.statusCode}: ${data}`));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(new Error(`Request to Cloudflare API failed: ${error.message}`));
    });
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    
    req.end();
  });
}

/**
 * List all deployments for a Cloudflare Pages project
 * @param {string} projectName - Project name
 * @param {string} token - Cloudflare API token
 * @param {string} accountId - Cloudflare account ID
 * @returns {Promise<array>} - List of deployments
 */
async function listDeployments(projectName, token, accountId) {
  const path = `/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments`;
  const response = await cloudflareApiRequest('GET', path, token);
  return response.result;
}

/**
 * Delete a specific deployment
 * @param {string} projectName - Project name
 * @param {string} deploymentId - Deployment ID
 * @param {string} token - Cloudflare API token
 * @param {string} accountId - Cloudflare account ID
 * @returns {Promise<void>}
 */
async function deleteDeployment(projectName, deploymentId, token, accountId) {
  const path = `/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments/${deploymentId}`;
  await cloudflareApiRequest('DELETE', path, token);
  core.info(`Deleted deployment ${deploymentId} for project ${projectName}`);
}

/**
 * Delete all deployments for a project (or at least enough to allow project deletion)
 * @param {string} projectName - Project name
 * @param {string} token - Cloudflare API token
 * @param {string} accountId - Cloudflare account ID
 * @returns {Promise<void>}
 */
async function cleanupDeployments(projectName, token, accountId) {
  try {
    core.info(`Cleaning up deployments for project ${projectName}`);
    const deployments = await listDeployments(projectName, token, accountId);
    
    if (!deployments || deployments.length === 0) {
      core.info('No deployments found to clean up');
      return;
    }
    
    core.info(`Found ${deployments.length} deployments. Will delete non-production deployments...`);
    
    // Sort deployments by creation date (oldest first)
    const sortedDeployments = deployments.sort((a, b) => {
      return new Date(a.created_on) - new Date(b.created_on);
    });
    
    // Delete deployments, keeping the most recent production one if possible
    const productionDeployment = sortedDeployments.find(d => d.environment === 'production');
    const deploymentsToDelete = productionDeployment 
      ? sortedDeployments.filter(d => d.id !== productionDeployment.id)
      : sortedDeployments;
    
    // Keep only 5 most recent deployments to avoid hitting API rate limits
    const deploymentsToKeep = 5;
    const deploymentsToActuallyDelete = deploymentsToDelete.slice(
      0, 
      deploymentsToDelete.length - deploymentsToKeep
    );
    
    if (deploymentsToActuallyDelete.length === 0) {
      core.warning(`Only found ${deploymentsToDelete.length} deployments to delete, which is less than the threshold (${deploymentsToKeep}). Trying to delete the project anyway.`);
      return;
    }
    
    core.info(`Deleting ${deploymentsToActuallyDelete.length} deployments...`);
    
    for (const deployment of deploymentsToActuallyDelete) {
      await deleteDeployment(projectName, deployment.id, token, accountId);
      // Add a small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    core.info(`Successfully deleted ${deploymentsToActuallyDelete.length} deployments`);
  } catch (error) {
    core.warning(`Error cleaning up deployments: ${error.message}. Will try to delete the project anyway.`);
  }
}

/**
 * Post a comment on the PR with the deployment URL
 * @param {string} token - GitHub token
 * @param {string} deployUrl - URL of the deployment
 * @returns {Promise<void>}
 */
async function commentOnPR(token, deployUrl) {
  try {
    const octokit = github.getOctokit(token);
    const context = github.context;
    
    // Only comment on pull requests
    if (!context.payload.pull_request) {
      core.info('Not a pull request, skipping comment creation');
      return;
    }
    
    const prNumber = context.payload.pull_request.number;
    
    core.info(`Posting deployment comment on PR #${prNumber}`);
    
    try {
      await octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
        body: `🚀 PR Preview deployed to: ${deployUrl}`
      });
      
      core.info(`Successfully posted comment on PR #${prNumber}`);
    } catch (error) {
      // Don't fail the action if comment creation fails
      core.warning(`Failed to post comment on PR: ${error.message}`);
    }
  } catch (error) {
    core.warning(`Error posting comment on PR: ${error.message}`);
  }
}

/**
 * Post a comment on the PR about cleanup
 * @param {string} token - GitHub token
 * @returns {Promise<void>}
 */
async function commentOnPRCleanup(token) {
  try {
    const octokit = github.getOctokit(token);
    const context = github.context;
    
    // Only comment on pull requests
    if (!context.payload.pull_request) {
      core.info('Not a pull request, skipping cleanup comment');
      return;
    }
    
    const prNumber = context.payload.pull_request.number;
    
    core.info(`Posting cleanup comment on PR #${prNumber}`);
    
    try {
      await octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
        body: `🧹 PR Preview environment has been cleaned up.`
      });
      
      core.info(`Successfully posted cleanup comment on PR #${prNumber}`);
    } catch (error) {
      // Don't fail the action if comment creation fails
      core.warning(`Failed to post cleanup comment on PR: ${error.message}`);
    }
  } catch (error) {
    core.warning(`Error posting cleanup comment on PR: ${error.message}`);
  }
}

/**
 * Creates a GitHub deployment and deployment status
 * @param {string} token - GitHub token
 * @param {string} url - Deployment URL
 * @param {string} environment - Environment name
 * @returns {Promise<void>}
 */
async function createGitHubDeployment(token, url, environment) {
  try {
    const octokit = github.getOctokit(token);
    const context = github.context;
    
    // Only create deployment for pull requests
    if (!context.payload.pull_request) {
      core.info('Not a pull request, skipping GitHub deployment creation');
      return;
    }
    
    const prNumber = context.payload.pull_request.number;
    const sha = context.payload.pull_request.head.sha;
    const envName = `${environment}/pr-${prNumber}`;
    
    core.info(`Creating GitHub deployment for PR #${prNumber} (${sha}) in environment ${envName}`);
    
    try {
      // Create deployment
      const deployment = await octokit.rest.repos.createDeployment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        ref: sha,
        environment: envName,
        auto_merge: false,
        required_contexts: [],
        transient_environment: true,
      });
      
      // Create deployment status
      await octokit.rest.repos.createDeploymentStatus({
        owner: context.repo.owner,
        repo: context.repo.repo,
        deployment_id: deployment.data.id,
        state: 'success',
        environment_url: url,
        description: 'Preview deployment is live',
      });
      
      core.info(`GitHub deployment created successfully: ${url}`);
    } catch (error) {
      // Don't fail the action if deployment creation fails
      core.warning(`Failed to create GitHub deployment: ${error.message}`);
    }
  } catch (error) {
    core.warning(`Error setting up GitHub deployment: ${error.message}`);
  }
}

/**
 * Deactivates any active GitHub deployments for the PR
 * @param {string} token - GitHub token
 * @param {string} environment - Base environment name
 * @returns {Promise<void>}
 */
async function deactivateGitHubDeployments(token, environment) {
  try {
    const octokit = github.getOctokit(token);
    const context = github.context;
    
    // Only deactivate deployments for pull requests
    if (!context.payload.pull_request) {
      core.info('Not a pull request, skipping GitHub deployment deactivation');
      return;
    }
    
    const prNumber = context.payload.pull_request.number;
    const envName = `${environment}/pr-${prNumber}`;
    
    core.info(`Deactivating GitHub deployments for PR #${prNumber} in environment ${envName}`);
    
    try {
      // Get active deployments for this environment
      const deployments = await octokit.rest.repos.listDeployments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        environment: envName,
      });
      
      if (deployments.data.length === 0) {
        core.info('No active deployments found for this environment');
        return;
      }
      
      // Mark each deployment as inactive
      for (const deployment of deployments.data) {
        await octokit.rest.repos.createDeploymentStatus({
          owner: context.repo.owner,
          repo: context.repo.repo,
          deployment_id: deployment.id,
          state: 'inactive',
          description: 'Environment was cleaned up',
        });
        core.info(`Deactivated deployment ${deployment.id}`);
      }
      
      core.info(`Successfully deactivated ${deployments.data.length} deployment(s)`);
    } catch (error) {
      // Don't fail the action if deactivation fails
      core.warning(`Failed to deactivate GitHub deployments: ${error.message}`);
    }
  } catch (error) {
    core.warning(`Error deactivating GitHub deployments: ${error.message}`);
  }
}

/**
 * Deploys a folder to Cloudflare Pages
 * @param {string} distFolder - Path to the distribution folder to deploy
 * @param {string} projectName - Cloudflare Pages project name
 * @param {string} branch - Branch name to deploy to
 * @param {string} headersJson - JSON string containing custom headers configuration
 * @returns {Promise<string>} - URL of the deployed site
 */
async function deployToCloudflare(distFolder, projectName, branch, headersJson) {
  core.info(`Deploying ${distFolder} to Cloudflare Pages project "${projectName}" on branch "${branch}"`);
  
  try {
    await fs.access(distFolder);
  } catch (error) {
    throw new Error(`Distribution folder "${distFolder}" does not exist or is not accessible`);
  }

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

  let deployOutput = '';
  let errorOutput = '';
  
  const options = {
    listeners: {
      stdout: (data) => {
        const chunk = data.toString();
        deployOutput += chunk;
        if (chunk.trim()) core.info(chunk.trim());
      },
      stderr: (data) => {
        const chunk = data.toString();
        errorOutput += chunk;
        if (chunk.trim()) core.warning(chunk.trim());
      }
    }
  };

  try {
    await exec.exec('npx', ['wrangler@4', 'pages', 'deploy', distFolder, '--project-name', projectName, '--branch', branch], options);
  } catch (error) {
    throw new Error(`Wrangler deployment failed: ${errorOutput || error.message}`);
  }

  // First, try to extract the deployment alias URL (✨ Deployment alias URL: ...)
  const aliasUrlRegex = /✨\s*Deployment alias URL:\s*(\bhttps?:\/\/[^\s]+\b)/i;
  const aliasMatch = deployOutput.match(aliasUrlRegex);
  
  // If we can't find the alias URL, fall back to other patterns
  const standardUrlRegex = /(?:View your deployed site at|Successfully deployed to|Preview URL|✨\s*Deployment complete! Take a peek over at)[:\s]+(\bhttps?:\/\/[^\s]+\b)/i;
  const standardMatch = deployOutput.match(standardUrlRegex);
  
  let deployUrl;
  
  if (aliasMatch && aliasMatch[1]) {
    deployUrl = aliasMatch[1].trim();
    core.info(`Deployment successful (alias URL): ${deployUrl}`);
  } else if (standardMatch && standardMatch[1]) {
    deployUrl = standardMatch[1].trim();
    core.info(`Deployment successful: ${deployUrl}`);
  } else {
    core.warning('Could not extract deployment URL from output. Deployment might have succeeded, but no URL was found.');
    deployUrl = `https://${branch === 'main' ? '' : branch + '.'}${projectName}.pages.dev`;
    core.info(`Guessed deployment URL (may not be accurate): ${deployUrl}`);
  }
  
  core.setOutput('url', deployUrl);
  return deployUrl;
}

/**
 * Deletes a Cloudflare Pages project
 * @param {string} projectName - Name of the Cloudflare Pages project to delete
 * @param {string} token - Cloudflare API token
 * @param {string} accountId - Cloudflare account ID
 * @returns {Promise<void>}
 */
async function deleteFromCloudflare(projectName, token, accountId) {
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
    await exec.exec('npx', ['wrangler@4', 'pages', 'project', 'delete', projectName, '--yes'], options);
    core.info(`Successfully deleted project "${projectName}"`);
  } catch (error) {
    if (errorOutput.includes('not found') || errorOutput.includes('does not exist')) {
      core.warning(`Project "${projectName}" does not exist or is already deleted.`);
    } else if (errorOutput.includes('too many deployments') || errorOutput.includes('8000076')) {
      throw new Error(`Project has too many deployments to be deleted: ${errorOutput}`);
    } else {
      throw new Error(`Failed to delete project: ${errorOutput || error.message}`);
    }
  }
}

run();