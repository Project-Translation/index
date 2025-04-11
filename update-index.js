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
    this.tableHeader = '| Project | Original Repository | Description | Stars |\n| --- | --- | --- | --- |';
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
   */
  constructor(data) {
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
      description: data.parent.description || 'No description',
      stars: data.parent.stargazers_count
    } : null;
    this.language = data.language;
    this.topics = data.topics || [];
    this.owner = data.owner.login;
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
   * @param {string} repoName - Repository name.
   * @returns {Promise<RepositoryModel>} - Repository model with detailed information.
   */
  static async getRepositoryDetails(repoName) {
    try {
      const data = await this.fetchFromGitHub(`/repos/${CONFIG.organization}/${repoName}`);
      return new RepositoryModel(data);
    } catch (error) {
      console.error(`Failed to fetch details for ${repoName}: ${error.message}`);
      throw error;
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
      // Skip excluded repositories by name
      if (CONFIG.excludedRepos.includes(repo.name)) {
        return false;
      }
      
      // Keep only forks that have parent information
      return repo.isFork && repo.parent;
    });
  }

  /**
   * Formats repository data into table rows for the README.
   * @param {RepositoryModel[]} repositories - Array of repository models.
   * @returns {string} - Formatted markdown table rows.
   */
  static formatRepositoriesTable(repositories) {
    // Group repositories by their original source
    const projectGroups = new Map();
    
    repositories.forEach(repo => {
      if (!repo.parent) return; // Skip repos without parents
      
      const projectKey = repo.parent.fullName;
      
      if (!projectGroups.has(projectKey)) {
        projectGroups.set(projectKey, {
          parent: repo.parent,
          translations: []
        });
      }
      
      projectGroups.get(projectKey).translations.push(repo);
    });
    
    // Format the table rows
    let tableContent = '';
    
    for (const [projectKey, group] of projectGroups.entries()) {
      const parentRepo = group.parent;
      const translation = group.translations[0]; // Get the translation repository
      
      // Use the translated repo name for the Project column
      const translationRepoName = translation.name;
      
      // Format description to avoid table breaking due to line breaks
      const description = parentRepo.description
        .replace(/\r?\n/g, ' ')
        .replace(/\|/g, '\\|');
      
      // Use the translation repo name and URL in the Project column
      tableContent += `| [${translationRepoName}](${translation.url}) `;
      tableContent += `| [${parentRepo.fullName}](${parentRepo.url}) `;
      tableContent += `| ${description} `;
      tableContent += `| ${parentRepo.stars} `;
      tableContent += '|\n';
    }
    
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
      const readmeContent = fs.readFileSync(readmePath, 'utf8');
      
      // Split the file content to get the header part
      const headerMatch = readmeContent.match(/^([\s\S]*?)(?=\| Project)/m);
      const header = headerMatch ? headerMatch[1].trim() : '# index\nIndex of translations.';
      
      // Build the new content with updated table format
      const newContent = `${header}\n\n${CONFIG.tableHeader}\n${tableContent}`;
      
      fs.writeFileSync(readmePath, newContent);
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
      
      // Get all repositories from the organization
      const repos = await GitHubApiClient.getOrganizationRepositories();
      console.log(`Found ${repos.length} repositories`);
      
      // Get detailed information for each repository
      const repoDetailsPromises = repos.map(repo => 
        GitHubApiClient.getRepositoryDetails(repo.name));
      
      const repoDetails = await Promise.all(repoDetailsPromises);
      
      // Filter repositories based on criteria
      const filteredRepos = RepositoryService.filterRepositories(repoDetails);
      console.log(`Filtered to ${filteredRepos.length} repositories`);
      
      // Format the repositories into a table
      const tableContent = RepositoryService.formatRepositoriesTable(filteredRepos);
      
      // Update the README.md file
      FileService.updateReadme(tableContent);
      
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  }
}

// Execute the script
AppController.run();