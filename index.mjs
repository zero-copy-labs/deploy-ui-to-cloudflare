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
    const commentOnPr = core.getInput('COMMENT_ON_PR') === 'true';
    const commentOnPrCleanup = core.getInput('COMMENT_ON_PR_CLEANUP') === 'true';
    const prNumber = core.getInput('PR_NUMBER') || (github.context.payload.pull_request?.number?.toString() || '');

    if (!cloudflareApiToken || !cloudflareAccountId || !projectName) {
      throw new Error('Required inputs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and PROJECT_NAME must be non-empty');
    }

    if (event !== 'deploy' && event !== 'delete-project' && event !== 'delete-deployment') {
      throw new Error('EVENT must be either "deploy", "delete-deployment", or "delete-project"');
    }

    core.setSecret(cloudflareApiToken);
    if (githubToken) {
      core.setSecret(githubToken);
    }
    
    process.env.CLOUDFLARE_API_TOKEN = cloudflareApiToken;
    process.env.CLOUDFLARE_ACCOUNT_ID = cloudflareAccountId;

    if (event === 'deploy') {
      const deployUrl = await deployToCloudflare(distFolder, projectName, branch, headers);
      
      if (githubToken) {
        // Create GitHub deployment if token is provided
        await createGitHubDeployment(githubToken, deployUrl, environmentName);
        
        // Comment on PR with deployment URL if enabled and PR number is available
        if (commentOnPr && prNumber) {
          try {
            await commentOnPullRequest(
              githubToken,
              prNumber,
              `🚀 PR Preview deployed to: ${deployUrl}`
            );
            core.info(`Added deployment comment to PR #${prNumber}`);
          } catch (commentError) {
            // Don't fail the whole action if commenting fails
            core.warning(`Failed to add deployment comment to PR #${prNumber}: ${commentError.message}`);
          }
        }
      } else {
        core.info('No GitHub token provided, skipping deployment status creation and PR comments');
      }
    } else if (event === 'delete-deployment') {
      // Delete specific deployment but keep the project
      await deleteDeploymentFromCloudflare(projectName, branch);
      
      if (githubToken) {
        // Deactivate GitHub deployments if token is provided
        await deactivateGitHubDeployments(githubToken, environmentName);
        
        // Add cleanup comment on PR if enabled and PR number is available
        if (commentOnPrCleanup && prNumber) {
          try {
            await commentOnPullRequest(
              githubToken,
              prNumber,
              `🧹 PR Preview environment has been cleaned up.`
            );
            core.info(`Added cleanup comment to PR #${prNumber}`);
          } catch (commentError) {
            // Don't fail the whole action if commenting fails
            core.warning(`Failed to add cleanup comment to PR #${prNumber}: ${commentError.message}`);
          }
        }
      } else {
        core.info('No GitHub token provided, skipping deployment deactivation and PR comments');
      }
    } else {
      // Delete entire project (original behavior)
      await deleteProjectFromCloudflare(projectName);
      
      if (githubToken) {
        // Deactivate GitHub deployments if token is provided
        await deactivateGitHubDeployments(githubToken, environmentName);
        
        // Add cleanup comment on PR if enabled and PR number is available
        if (commentOnPrCleanup && prNumber) {
          try {
            await commentOnPullRequest(
              githubToken,
              prNumber,
              `🧹 PR Preview environment has been cleaned up.`
            );
            core.info(`Added cleanup comment to PR #${prNumber}`);
          } catch (commentError) {
            // Don't fail the whole action if commenting fails
            core.warning(`Failed to add cleanup comment to PR #${prNumber}: ${commentError.message}`);
          }
        }
      } else {
        core.info('No GitHub token provided, skipping deployment deactivation and PR comments');
      }
    }

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

/**
 * Comments on a pull request
 * @param {string} token - GitHub token
 * @param {string} prNumber - Pull request number
 * @param {string} comment - Comment body
 * @returns {Promise<void>}
 */
async function commentOnPullRequest(token, prNumber, comment) {
  if (!token || !prNumber) {
    throw new Error('GitHub token and PR number are required to comment on a PR');
  }
  
  const octokit = github.getOctokit(token);
  const context = github.context;
  
  core.info(`Adding comment to PR #${prNumber}`);
  
  try {
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: parseInt(prNumber),
      body: comment
    });
  } catch (error) {
    throw new Error(`Failed to comment on PR #${prNumber}: ${error.message}`);
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
 * Deletes a specific deployment from a Cloudflare Pages project
 * @param {string} projectName - Name of the Cloudflare Pages project
 * @param {string} branch - Branch name of the deployment to delete
 * @returns {Promise<void>}
 */
async function deleteDeploymentFromCloudflare(projectName, branch) {
  core.info(`Deleting Cloudflare Pages deployment for project "${projectName}" on branch "${branch}"`);
  
  let deploymentId = null;
  let listOutput = '';
  let errorOutput = '';
  
  // First, list deployments to find the specific one to delete
  const listOptions = {
    listeners: {
      stdout: (data) => {
        listOutput += data.toString();
      },
      stderr: (data) => {
        errorOutput += data.toString();
      }
    }
  };
  
  try {
    // Get a list of deployments for this project
    await exec.exec('npx', ['wrangler@4', 'pages', 'deployment', 'list', projectName], listOptions);
    
    // Parse the output to find the deployment ID for the specified branch
    const deployments = listOutput.split('\n');
    for (const line of deployments) {
      if (line.includes(branch)) {
        // Extract the deployment ID (usually at the beginning of the line)
        const match = line.match(/([a-zA-Z0-9-]+)\s+/);
        if (match && match[1]) {
          deploymentId = match[1];
          break;
        }
      }
    }
  } catch (error) {
    if (errorOutput.includes('not found') || errorOutput.includes('does not exist')) {
      core.warning(`Project "${projectName}" does not exist.`);
      return;
    } else {
      core.warning(`Error listing deployments: ${errorOutput || error.message}`);
      // Continue with the deletion attempt even if we couldn't get the ID
    }
  }
  
  // If we couldn't find a specific deployment ID, log a warning
  if (!deploymentId) {
    core.warning(`Could not find a specific deployment ID for branch "${branch}". Will try to clean up GitHub resources.`);
    return;
  }
  
  // Now delete the specific deployment
  errorOutput = '';
  const deleteOptions = {
    listeners: {
      stderr: (data) => {
        errorOutput += data.toString();
      }
    }
  };
  
  try {
    await exec.exec('npx', ['wrangler@4', 'pages', 'deployment', 'delete', projectName, deploymentId, '--yes'], deleteOptions);
    core.info(`Successfully deleted deployment "${deploymentId}" for project "${projectName}"`);
  } catch (error) {
    if (errorOutput.includes('not found') || errorOutput.includes('does not exist')) {
      core.warning(`Deployment "${deploymentId}" does not exist or is already deleted.`);
    } else {
      core.warning(`Failed to delete deployment: ${errorOutput || error.message}`);
      // Don't throw an error here, just log a warning so the rest of the cleanup can proceed
    }
  }
}

/**
 * Deletes an entire Cloudflare Pages project
 * @param {string} projectName - Name of the Cloudflare Pages project to delete
 * @returns {Promise<void>}
 */
async function deleteProjectFromCloudflare(projectName) {
  core.info(`Deleting Cloudflare Pages project "${projectName}"`);
  
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
    } else {
      throw new Error(`Failed to delete project: ${errorOutput || error.message}`);
    }
  }
}

run();