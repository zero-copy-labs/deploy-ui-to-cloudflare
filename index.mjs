import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import path from 'path';

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
    const createProjectIfMissing = core.getBooleanInput('CREATE_PROJECT_IF_MISSING') || true;
    const cleanupOldDeployments = core.getBooleanInput('CLEANUP_OLD_DEPLOYMENTS') || false;
    const deploymentPrefix = core.getInput('DEPLOYMENT_PREFIX') || '';
    const keepDeployments = parseInt(core.getInput('KEEP_DEPLOYMENTS') || '5', 10);

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
      // Check if project exists and create it if needed
      const projectExists = await checkProjectExists(projectName);
      
      if (!projectExists) {
        if (createProjectIfMissing) {
          core.info(`Project "${projectName}" does not exist. Creating it...`);
          await createProject(projectName);
        } else {
          throw new Error(`Project "${projectName}" does not exist and CREATE_PROJECT_IF_MISSING is set to false`);
        }
      }
      
      // Deploy to Cloudflare
      const deployUrl = await deployToCloudflare(distFolder, projectName, branch, headers);
      
      // If we have a GitHub token, create a deployment and post a comment
      if (githubToken) {
        await createGitHubDeployment(githubToken, deployUrl, environmentName);
        await commentOnPR(githubToken, deployUrl);
      } else {
        core.info('No GitHub token provided, skipping deployment status creation and PR comment');
      }
      
      // Clean up old deployments if requested
      if (cleanupOldDeployments) {
        core.info(`Cleaning up old deployments for project "${projectName}"`);
        await managePrDeployments(projectName, deploymentPrefix, keepDeployments);
      }
    } else {
      // For PR deletion, we want to delete all deployments with the PR prefix
      if (deploymentPrefix) {
        core.info(`Deleting all deployments with prefix "${deploymentPrefix}" for project "${projectName}"`);
        await deleteMatchingDeployments(projectName, deploymentPrefix);
      } else {
        core.info(`No deployment prefix provided, skipping selective deletion`);
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
 * List all deployments for a project
 * @param {string} projectName - Project name
 * @returns {Promise<Array>} - List of deployments
 */
async function listProjectDeployments(projectName) {
  core.info(`Listing deployments for project "${projectName}"`);
  
  let deploymentOutput = '';
  let errorOutput = '';
  
  const options = {
    listeners: {
      stdout: (data) => {
        const chunk = data.toString();
        deploymentOutput += chunk;
      },
      stderr: (data) => {
        const chunk = data.toString();
        errorOutput += chunk;
      }
    }
  };

  try {
    await exec.exec('npx', ['wrangler@4', 'pages', 'deployment', 'list', '--project-name', projectName], options);
    
    // Parse deployment information from the output
    const deployments = [];
    const lines = deploymentOutput.split('\n');
    
    let currentDeployment = null;
    
    for (const line of lines) {
      const idMatch = line.match(/Deployment ID: ([a-f0-9-]+)/);
      if (idMatch) {
        if (currentDeployment) {
          deployments.push(currentDeployment);
        }
        currentDeployment = { id: idMatch[1] };
        continue;
      }
      
      if (!currentDeployment) continue;
      
      const createdMatch = line.match(/Created on: (.+)/);
      if (createdMatch && currentDeployment) {
        currentDeployment.created = createdMatch[1];
        continue;
      }
      
      const aliasMatch = line.match(/Aliases: (.+)/);
      if (aliasMatch && currentDeployment) {
        currentDeployment.aliases = aliasMatch[1].split(',').map(a => a.trim());
        continue;
      }
      
      const activeMatch = line.match(/Active/i);
      if (activeMatch && currentDeployment) {
        currentDeployment.active = true;
      }
    }
    
    // Add the last deployment if it exists
    if (currentDeployment) {
      deployments.push(currentDeployment);
    }
    
    core.info(`Found ${deployments.length} deployments for project "${projectName}"`);
    return deployments;
  } catch (error) {
    if (errorOutput.includes('not found') || errorOutput.includes('does not exist')) {
      core.warning(`Project "${projectName}" does not exist or has no deployments.`);
      return [];
    }
    throw new Error(`Failed to list deployments: ${errorOutput || error.message}`);
  }
}

/**
 * Delete a specific deployment
 * @param {string} projectName - Project name
 * @param {string} deploymentId - Deployment ID
 * @returns {Promise<boolean>} - Success status
 */
async function deleteDeployment(projectName, deploymentId) {
  core.info(`Deleting deployment ${deploymentId} from project "${projectName}"`);
  
  let errorOutput = '';
  const options = {
    listeners: {
      stderr: (data) => {
        errorOutput += data.toString();
      }
    }
  };

  try {
    await exec.exec('npx', ['wrangler@4', 'pages', 'deployment', 'delete', deploymentId, '--project-name', projectName, '--yes'], options);
    core.info(`Successfully deleted deployment ${deploymentId}`);
    return true;
  } catch (error) {
    core.warning(`Failed to delete deployment ${deploymentId}: ${errorOutput || error.message}`);
    return false;
  }
}

/**
 * Delete all deployments that match a specific prefix
 * @param {string} projectName - Project name
 * @param {string} prefix - Prefix to match in deployment aliases
 * @returns {Promise<void>}
 */
async function deleteMatchingDeployments(projectName, prefix) {
  const deployments = await listProjectDeployments(projectName);
  
  if (deployments.length === 0) {
    core.info(`No deployments found for project "${projectName}"`);
    return;
  }
  
  // Find deployments with matching aliases
  const matchingDeployments = deployments.filter(deployment => {
    if (!deployment.aliases) return false;
    return deployment.aliases.some(alias => alias.includes(prefix));
  });
  
  if (matchingDeployments.length === 0) {
    core.info(`No deployments with prefix "${prefix}" found`);
    return;
  }
  
  core.info(`Found ${matchingDeployments.length} deployments with prefix "${prefix}"`);
  
  // Delete matching deployments
  let successCount = 0;
  for (const deployment of matchingDeployments) {
    const success = await deleteDeployment(projectName, deployment.id);
    if (success) successCount++;
    
    // Add a small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  core.info(`Successfully deleted ${successCount}/${matchingDeployments.length} deployments`);
}

/**
 * Manage PR deployments - keep recent ones and delete older ones
 * @param {string} projectName - Project name
 * @param {string} prefix - PR prefix to identify deployments
 * @param {number} keepCount - Number of deployments to keep
 * @returns {Promise<void>}
 */
async function managePrDeployments(projectName, prefix, keepCount) {
  const deployments = await listProjectDeployments(projectName);
  
  if (deployments.length === 0) {
    core.info(`No deployments found for project "${projectName}"`);
    return;
  }
  
  // Find deployments with matching aliases and sort by creation date (newest first)
  const matchingDeployments = deployments
    .filter(deployment => {
      if (!deployment.aliases) return false;
      return prefix ? deployment.aliases.some(alias => alias.includes(prefix)) : true;
    })
    .sort((a, b) => {
      const dateA = new Date(a.created);
      const dateB = new Date(b.created);
      return dateB - dateA; // Newest first
    });
  
  if (matchingDeployments.length === 0) {
    core.info(`No deployments${prefix ? ` with prefix "${prefix}"` : ''} found`);
    return;
  }
  
  if (matchingDeployments.length <= keepCount) {
    core.info(`Only ${matchingDeployments.length} deployments found, which is less than the threshold (${keepCount}). No cleanup needed.`);
    return;
  }
  
  // Keep the newest ones, delete the rest
  const deploymentsToDelete = matchingDeployments.slice(keepCount);
  
  core.info(`Keeping ${keepCount} newest deployments, deleting ${deploymentsToDelete.length} older ones`);
  
  let successCount = 0;
  for (const deployment of deploymentsToDelete) {
    const success = await deleteDeployment(projectName, deployment.id);
    if (success) successCount++;
    
    // Add a small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  core.info(`Successfully deleted ${successCount}/${deploymentsToDelete.length} deployments`);
}

/**
 * Check if a project exists
 * @param {string} projectName - Project name
 * @returns {Promise<boolean>} - True if the project exists
 */
async function checkProjectExists(projectName) {
  let output = '';
  let errorOutput = '';
  const options = {
    listeners: {
      stdout: (data) => {
        output += data.toString();
      },
      stderr: (data) => {
        errorOutput += data.toString();
      }
    }
  };

  try {
    // Use the list command instead of non-existent info command
    await exec.exec('npx', ['wrangler@4', 'pages', 'project', 'list'], options);
    
    // Check if the project name is in the output
    const projects = output.split('\n').filter(line => line.trim());
    const projectExists = projects.some(project => project.trim() === projectName);
    
    if (projectExists) {
      core.info(`Project "${projectName}" exists`);
      return true;
    } else {
      core.info(`Project "${projectName}" does not exist`);
      return false;
    }
  } catch (error) {
    // If we can't determine, assume it doesn't exist
    core.warning(`Error checking if project exists: ${errorOutput || error.message}`);
    return false;
  }
}

/**
 * Create a new Cloudflare Pages project
 * @param {string} projectName - Project name
 * @returns {Promise<void>}
 */
async function createProject(projectName) {
  let errorOutput = '';
  const options = {
    listeners: {
      stderr: (data) => {
        errorOutput += data.toString();
      }
    }
  };

  try {
    await exec.exec('npx', ['wrangler@4', 'pages', 'project', 'create', projectName, '--production-branch', 'main'], options);
    core.info(`Successfully created project "${projectName}"`);
  } catch (error) {
    throw new Error(`Failed to create project: ${errorOutput || error.message}`);
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

  // First, try to extract the primary URL (with hash) 
  const primaryUrlRegex = /Deployment complete! Take a peek over at\s+(\bhttps?:\/\/[^\s]+\b)/i;
  const primaryMatch = deployOutput.match(primaryUrlRegex);
  
  // Then try the alias URL
  const aliasUrlRegex = /Deployment alias URL:\s+(\bhttps?:\/\/[^\s]+\b)/i;
  const aliasMatch = deployOutput.match(aliasUrlRegex);
  
  // And finally any standard URL format
  const standardUrlRegex = /(?:View your deployed site at|Successfully deployed to|Preview URL)[:\s]+(\bhttps?:\/\/[^\s]+\b)/i;
  const standardMatch = deployOutput.match(standardUrlRegex);
  
  let deployUrl;
  
  if (primaryMatch && primaryMatch[1]) {
    deployUrl = primaryMatch[1].trim();
    core.info(`Using primary deployment URL: ${deployUrl}`);
  } else if (aliasMatch && aliasMatch[1]) {
    deployUrl = aliasMatch[1].trim();
    core.info(`Using alias deployment URL: ${deployUrl}`);
  } else if (standardMatch && standardMatch[1]) {
    deployUrl = standardMatch[1].trim();
    core.info(`Using standard deployment URL: ${deployUrl}`);
  } else {
    core.warning('Could not extract deployment URL from output. Deployment might have succeeded, but no URL was found.');
    deployUrl = `https://${branch === 'main' ? '' : branch + '.'}${projectName}.pages.dev`;
    core.info(`Guessed deployment URL (may not be accurate): ${deployUrl}`);
  }
  
  core.setOutput('url', deployUrl);
  return deployUrl;
}

run();