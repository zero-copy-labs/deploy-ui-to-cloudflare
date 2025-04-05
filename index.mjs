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
/**
 * Deletes all deployments for a specific branch from a Cloudflare Pages project using the Cloudflare API
 * Implementation based on the proven curl approach
 * @param {string} projectName - Name of the Cloudflare Pages project
 * @param {string} branch - Branch name of the deployment to delete
 * @returns {Promise<void>}
 */
/**
 * Handles branch-specific deployment cleanup for Cloudflare Pages
 * Uses Cloudflare's REST API to filter and delete all deployments for a specific branch
 * @param {string} projectName - Name of the Cloudflare Pages project
 * @param {string} branch - Branch name of the deployments to delete
 * @returns {Promise<void>}
 */
async function deleteDeploymentFromCloudflare(projectName, branch) {
  core.info(`Deleting all Cloudflare Pages deployments for project "${projectName}" on branch "${branch}"`);
  
  const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  
  if (!cloudflareApiToken || !cloudflareAccountId) {
    core.warning('Missing Cloudflare API credentials. Skipping Cloudflare deployment deletion.');
    return;
  }
  
  try {
    // Step 1: List deployments to find the ones for our branch
    const listDeploymentsUrl = `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/pages/projects/${projectName}/deployments`;
    
    core.info(`Fetching deployments list for project "${projectName}"...`);
    
    const headers = {
      'Authorization': `Bearer ${cloudflareApiToken}`,
      'Content-Type': 'application/json'
    };
    
    try {
      const response = await fetch(listDeploymentsUrl, { headers });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to list deployments: ${response.status} ${response.statusText} - ${errorText}`);
      }
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(`API error: ${JSON.stringify(data.errors)}`);
      }
      
      // Find all deployments for our branch
      const deployments = data.result;
      core.info(`Found ${deployments.length} total deployments for project "${projectName}"`);
      
      // Primary matching: by branch metadata (most accurate)
      let matchingDeployments = deployments.filter(deployment => 
        deployment.deployment_trigger && 
        deployment.deployment_trigger.metadata && 
        deployment.deployment_trigger.metadata.branch === branch
      );
      
      // If no direct matches, try fuzzy matching via URL patterns (fallback)
      if (matchingDeployments.length === 0) {
        core.info(`No exact branch matches found. Trying URL pattern matching for branch "${branch}"`);
        
        // Format branch name for URL matching
        const branchFormatted = branch.toLowerCase().replace(/[^a-z0-9]/g, '-');
        
        matchingDeployments = deployments.filter(deployment => 
          deployment.url && deployment.url.includes(branchFormatted)
        );
        
        if (matchingDeployments.length > 0) {
          core.info(`Found ${matchingDeployments.length} deployments matching URL pattern for branch "${branch}"`);
        }
      }
      
      if (matchingDeployments.length === 0) {
        core.warning(`No deployments found for branch "${branch}". Will continue with GitHub cleanup.`);
        return;
      }
      
      core.info(`Found ${matchingDeployments.length} deployments for branch "${branch}"`);
      
      // Log deployment details for debugging
      matchingDeployments.forEach(deployment => {
        const id = deployment.id;
        const url = deployment.url || 'N/A';
        const createdAt = new Date(deployment.created_on).toISOString();
        core.info(`  - Deployment ${id}: ${url} (created: ${createdAt})`);
      });
      
      // Step 2: Delete all matching deployments in parallel
      core.info(`Deleting ${matchingDeployments.length} deployments in parallel...`);
      
      // Create an array of deletion promises (but don't wait for them yet)
      const deletionPromises = matchingDeployments.map(async (deployment) => {
        const deploymentId = deployment.id;
        const deleteDeploymentUrl = `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/pages/projects/${projectName}/deployments/${deploymentId}?force=true`;
        
        try {
          core.info(`Deleting deployment ${deploymentId}...`);
          
          const deleteResponse = await fetch(deleteDeploymentUrl, { 
            method: 'DELETE',
            headers 
          });
          
          if (!deleteResponse.ok) {
            const errorText = await deleteResponse.text();
            core.warning(`Failed to delete deployment ${deploymentId}: ${deleteResponse.status} ${deleteResponse.statusText} - ${errorText}`);
            return { id: deploymentId, success: false };
          }
          
          const deleteData = await deleteResponse.json();
          
          if (!deleteData.success) {
            core.warning(`API error during deletion of ${deploymentId}: ${JSON.stringify(deleteData.errors)}`);
            return { id: deploymentId, success: false };
          }
          
          core.info(`Successfully deleted deployment "${deploymentId}" for branch "${branch}"`);
          return { id: deploymentId, success: true };
        } catch (error) {
          core.warning(`Error during deletion of deployment ${deploymentId}: ${error.message}`);
          return { id: deploymentId, success: false };
        }
      });
      
      // Wait for all deletion operations to complete (in parallel)
      const results = await Promise.allSettled(deletionPromises);
      
      // Summarize results
      const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      const failed = matchingDeployments.length - successful;
      
      core.info(`Deployment cleanup complete: ${successful} deleted successfully, ${failed} failed`);
      
    } catch (fetchError) {
      if (fetchError.message.includes('not found') || fetchError.message.includes('does not exist')) {
        core.warning(`Project "${projectName}" or deployment not found. Continuing with GitHub cleanup.`);
      } else {
        core.warning(`Error during API request: ${fetchError.message}`);
        throw fetchError;
      }
    }
    
  } catch (error) {
    core.warning(`Failed to delete Cloudflare deployments: ${error.message}`);
    core.info('Will continue with GitHub cleanup despite Cloudflare API errors.');
    // Continue with the GitHub cleanup regardless
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