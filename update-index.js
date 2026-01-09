/**
 * GitHub Repository Index Generator
 * 
 * This script fetches repositories from the Project-Translation organization,
 * extracts relevant information, and updates the README.md file with a formatted table.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config();

/**
 * @class Configuration
 * @description Singleton pattern implementation for application configuration
 */
class Configuration {
  static instance = null;
  
  constructor() {
    this.organization = 'Project-Translation';
    this.apiBaseUrl = 'api.github.com';
    this.readmePath = path.join(__dirname, 'README.md');
    this.excludedRepos = ['index']; // Just exclude the index repo, not the organization
    this.tableHeader = '| Project | Original Repository | Description | Stars | Tags | Status |\n| --- | --- | --- | --- | --- | --- |';
    this.requestOptions = {
      headers: {
        'User-Agent': 'Project-Translation-Index-Generator',
        'Authorization': `token ${process.env.API_KEY}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    };
  }

  /**
   * Gets the singleton instance
   * @return {Configuration} The configuration instance
   */
  static getInstance() {
    if (!Configuration.instance) {
      Configuration.instance = new Configuration();
    }
    return Configuration.instance;
  }
}

// Get the configuration singleton
const CONFIG = Configuration.getInstance();

/**
 * @class RepositoryModel
 * @description Repository data model class representing a repository with its properties
 */
class RepositoryModel {
  /**
   * @param {Object} data - Repository data from GitHub API
   * @param {Object|null} parentData - Parent repository data (optional)
   */
  constructor(data, parentData = null) {
    this.name = data.name;
    this.fullName = data.full_name;
    this.url = data.html_url;
    this.description = data.description || 'No description';
    this.isFork = data.fork;
    this.stars = data.stargazers_count;
    this.parent = data.parent ? {
      fullName: data.parent.full_name,
      url: data.parent.html_url,
      owner: data.parent.owner.login,
      description: parentData?.description || data.parent.description || 'No description',
      stars: parentData?.stargazers_count ?? data.parent.stargazers_count ?? 0,
      topics: parentData?.topics || []
    } : null;
    this.language = data.language;
    this.topics = data.topics || [];
    this.owner = data.owner.login;
    this.isTranslated = false; // Will be set by checking .translation-cache directory
  }
}

/**
 * @class GitHubApiClient
 * @description Responsible for all GitHub API interactions (Repository pattern)
 */
class GitHubApiClient {
  /**
   * Fetches data from the GitHub API.
   * @param {string} endpoint - API endpoint to fetch.
   * @returns {Promise<Object>} - JSON response from the API.
   */
  static async fetchFromGitHub(endpoint) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: CONFIG.apiBaseUrl,
        path: endpoint,
        headers: CONFIG.requestOptions.headers,
        method: 'GET'
      };

      const req = https.request(options, res => {
        if (res.statusCode !== 200) {
          reject(new Error(`API request failed with status code ${res.statusCode}`));
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error('Failed to parse API response'));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Gets detailed repository information including parent data for forks.
   * Fetches parent repo details separately if it's a fork to get full data like topics.
   * @param {string} repoName - Repository name.
   * @returns {Promise<RepositoryModel>} - Repository model with detailed information.
   */
  static async getRepositoryDetails(repoName) {
    try {
      const repoData = await this.fetchFromGitHub(`/repos/${CONFIG.organization}/${repoName}`);
      let parentData = null;
      if (repoData.fork && repoData.parent) {
        try {
          console.log(`Fetching parent details for ${repoName}: ${repoData.parent.full_name}`);
          parentData = await this.fetchFromGitHub(`/repos/${repoData.parent.full_name}`);
        } catch (parentError) {
          console.error(`Failed to fetch full parent details for ${repoData.parent.full_name}: ${parentError.message}`);
        }
      }
      return new RepositoryModel(repoData, parentData);
    } catch (error) {
      console.error(`Failed to fetch details for ${repoName}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Checks if .translation-cache directory exists in the repository
   * @param {string} repoName - Repository name
   * @returns {Promise<boolean>} True if .translation-cache exists, false otherwise
   */
  static async checkTranslationCache(repoName) {
    try {
      // Get repository info to find the default branch
      const repoInfo = await this.fetchFromGitHub(`/repos/${CONFIG.organization}/${repoName}`);
      const defaultBranch = repoInfo.default_branch || 'main';
      
      // Check for .translation-cache directory in the default branch
      const contents = await this.fetchFromGitHub(`/repos/${CONFIG.organization}/${repoName}/contents/.translation-cache?ref=${defaultBranch}`);
      
      // Check if it's a directory (GitHub API returns array for directories)
      const isDirectory = Array.isArray(contents) || (contents && contents.type === 'dir');
      
      return isDirectory;
    } catch (error) {
      // 404 means directory doesn't exist
      if (error.message.includes('404') || error.message.includes('Not Found')) {
        return false;
      }
      console.error(`Error checking .translation-cache for ${repoName}: ${error.message}`);
      return false;
    }
  }

  /**
   * Gets all repositories from the organization
   * @returns {Promise<Array>} Array of repositories
   */
  static async getOrganizationRepositories() {
    try {
      return await this.fetchFromGitHub(`/orgs/${CONFIG.organization}/repos?per_page=100`);
    } catch (error) {
      console.error(`Failed to fetch organization repositories: ${error.message}`);
      throw error;
    }
  }
}

/**
 * @class RepositoryService
 * @description Service layer for handling repository business logic (Service pattern)
 */
class RepositoryService {
  /**
   * Filters repositories based on exclusion criteria
   * @param {Array<RepositoryModel>} repositories - List of repositories to filter
   * @returns {Array<RepositoryModel>} Filtered repositories
   */
  static filterRepositories(repositories) {
    return repositories.filter(repo => {
      if (CONFIG.excludedRepos.includes(repo.name)) {
        return false;
      }
      return repo.isFork && repo.parent;
    });
  }

  /**
   * Formats repository data into table rows for the README.
   * Sorts projects alphabetically and includes linked tags.
   * @param {RepositoryModel[]} repositories - Array of repository models.
   * @returns {string} - Formatted markdown table rows.
   */
  static formatRepositoriesTable(repositories) {
    const projectGroups = new Map();
    repositories.forEach(repo => {
      if (!repo.parent) return;
      const projectKey = repo.parent.fullName;
      if (!projectGroups.has(projectKey)) {
        projectGroups.set(projectKey, repo);
      }
    });

    const sortedRepos = Array.from(projectGroups.values()).sort((a, b) => {
      return a.name.localeCompare(b.name);
    });

    let tableContent = '';
    sortedRepos.forEach(repo => {
      const parentRepo = repo.parent;

      const description = (parentRepo.description || 'No description')
          .replace(/\|/g, '\\|')
          .replace(/\r?\n/g, ' ');

      const tags = (parentRepo.topics || [])
          .map(topic => `[\`${topic}\`](https://github.com/topics/${topic})`)
          .join(', ');

      const statusBadge = repo.isTranslated
        ? '✅ Translated'
        : '❌ Not Translated';

      tableContent += `| [${repo.name}](${repo.url}) `;
      tableContent += `| [${parentRepo.fullName}](${parentRepo.url}) `;
      tableContent += `| ${description} `;
      tableContent += `| ${parentRepo.stars} `;
      tableContent += `| ${tags || 'N/A'} `;
      tableContent += `| ${statusBadge} `;
      tableContent += '|\n';
    });

    return tableContent;
  }
}

/**
 * @class FileService
 * @description Handles all file operations (Facade pattern)
 */
class FileService {
  /**
   * Updates the README.md file with the generated table.
   * @param {string} tableContent - The formatted table content to insert.
   */
  static updateReadme(tableContent) {
    try {
      const readmePath = CONFIG.readmePath;
      let readmeContent = fs.readFileSync(readmePath, 'utf8');

      const tableStartMarker = '<!-- TABLE_START -->';
      const tableEndMarker = '<!-- TABLE_END -->';

      const startIndex = readmeContent.indexOf(tableStartMarker);
      const endIndex = readmeContent.indexOf(tableEndMarker);

      if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
        console.warn('Table markers not found in README.md, attempting fallback update.');
        const headerMatch = readmeContent.match(/^([\s\S]*?)(?=\| Project)/m);
        const header = headerMatch ? headerMatch[1].trim() : '# index\nIndex of translations.';
        readmeContent = `${header}\n\n${CONFIG.tableHeader}\n${tableContent}`;
      } else {
        const newTableSection = `${tableStartMarker}\n${CONFIG.tableHeader}\n${tableContent}${tableEndMarker}`;
        readmeContent = readmeContent.substring(0, startIndex) + newTableSection + readmeContent.substring(endIndex + tableEndMarker.length);
      }

      fs.writeFileSync(readmePath, readmeContent.trim() + '\n');
      console.log('README.md has been updated successfully');
    } catch (error) {
      console.error(`Failed to update README: ${error.message}`);
      throw error;
    }
  }
}

/**
 * Application controller class using Command pattern
 * @class AppController
 */
class AppController {
  /**
   * Main function to execute the script.
   */
  static async run() {
    try {
      console.log('Fetching repositories from the GitHub API...');
      
      const repos = await GitHubApiClient.getOrganizationRepositories();
      console.log(`Found ${repos.length} repositories`);
      
      const repoDetailsPromises = repos.map(repo =>
        GitHubApiClient.getRepositoryDetails(repo.name));
      
      const repoDetails = await Promise.all(repoDetailsPromises);
      
      // Check .translation-cache directory for each repository
      console.log('Checking translation status for each repository...');
      for (const repo of repoDetails) {
        repo.isTranslated = await GitHubApiClient.checkTranslationCache(repo.name);
        console.log(`  ${repo.name}: ${repo.isTranslated ? 'Translated' : 'Not translated'}`);
      }
      
      const filteredRepos = RepositoryService.filterRepositories(repoDetails);
      console.log(`Filtered to ${filteredRepos.length} repositories`);
      
      const tableContent = RepositoryService.formatRepositoriesTable(filteredRepos);
      
      FileService.updateReadme(tableContent);
      
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  }
}

// Execute the script
AppController.run();