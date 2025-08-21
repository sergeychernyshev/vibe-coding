#!/usr/bin/env node

const { execa } = require('execa');
const inquirer = require('inquirer');
const fs = require('fs/promises');
const path = require('path');
const { graphql } = require('@octokit/graphql');
const { Octokit } = require('@octokit/rest');
const simpleGit = require('simple-git');

const CONFIG_FILE = '.github-variables';

// --- Utility Functions ---

async function getGitRoot() {
  try {
    const git = simpleGit();
    const root = await git.revparse(['--show-toplevel']);
    return root;
  } catch (error) {
    console.error("Error: Not a git repository or git is not installed.");
    process.exit(1);
  }
}

async function getRepoInfo() {
    const gitRoot = await getGitRoot();
    const git = simpleGit(gitRoot);
    let remoteUrl = '';
    try {
        remoteUrl = await git.remote(['get-url', 'origin']);
        if (!remoteUrl) throw new Error(); // Throw to be caught below
    } catch (error) {
        throw new Error('Could not get remote URL for "origin". Make sure you have a remote named "origin".');
    }
    
    const match = remoteUrl.trim().match(/github\.com[/:]([\w-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (!match) {
        throw new Error(`Could not parse repository owner and name from git remote URL: ${remoteUrl}`);
    }
    return { owner: match[1], repo: match[2] };
}

async function checkAndAddScopes() {
    try {
        const { stdout } = await execa('gh', ['auth', 'status']);
        const lines = stdout.split('\n');
        const tokenLine = lines.find(line => line.includes('Token scopes:'));
        
        if (tokenLine && !tokenLine.includes('project')) {
            console.log("The 'project' scope is missing from your GitHub CLI authentication.");
            console.log("Attempting to refresh your token to add the required scope...");
            
            // Re-run the command with inherited stdio to allow for user interaction
            await execa('gh', ['auth', 'refresh', '-s', 'project'], { stdio: 'inherit' });

            console.log("Token refreshed successfully.");
        } else if (!tokenLine) {
            // This case might happen if gh auth status output changes.
            throw new Error("Could not determine token scopes from `gh auth status` output.");
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
             throw new Error('The `gh` command-line tool is not installed or not in your PATH.');
        }
        // Re-throw other errors to be caught by the main execution block
        throw error;
    }
}


async function getAuthToken() {
    try {
        const { stdout: token } = await execa('gh', ['auth', 'token']);
        if (!token) {
            throw new Error('The gh auth token command returned an empty value.');
        }
        return token.trim();
    } catch (error) {
        throw new Error('Could not get GitHub authentication token. Please make sure you are logged in with `gh auth login`.');
    }
}

let _graphqlWithAuth;
async function getAuthenticatedGraphql() {
  if (_graphqlWithAuth) return _graphqlWithAuth;
  const token = await getAuthToken();
  _graphqlWithAuth = graphql.defaults({
    headers: {
      authorization: `token ${token}`,
    },
  });
  return _graphqlWithAuth;
}

let _octokit;
async function getOctokit() {
    if (_octokit) return _octokit;
    const token = await getAuthToken();
    const { Octokit } = await import('@octokit/rest');
    _octokit = new Octokit({ auth: token });
    return _octokit;
}


// --- Core Logic ---

async function getProjectNumber() {
  const gitRoot = await getGitRoot();
  const configPath = path.join(gitRoot, CONFIG_FILE);

  try {
    const data = await fs.readFile(configPath, 'utf8');
    const match = data.match(/PROJECT_NUMBER=(\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const { owner, repo } = await getRepoInfo();
  
  const graphql = await getAuthenticatedGraphql();
  const { repository } = await graphql(`
    query getProjects($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        id
        projects(first: 100, states: [OPEN]) {
          nodes {
            number
            name
          }
        }
      }
    }
  `, { owner, repo });

  const projects = repository.projects.nodes.map(p => ({ name: `${p.number} ${p.name}`, value: p.number }));

  if (projects.length === 0) {
    const { createNew } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'createNew',
        message: 'No open projects found. Would you like to create one?',
        default: true,
      },
    ]);

    if (!createNew) {
      console.log('Aborting. No project selected.');
      process.exit(0);
    }

    const defaultProjectName = repo
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

    const { projectName } = await inquirer.prompt([
        {
            type: 'input',
            name: 'projectName',
            message: 'Enter the name for the new project:',
            default: defaultProjectName,
            validate: input => input ? true : 'Project name cannot be empty.',
        }
    ]);

    // First, we need the owner's node ID for the createProjectV2 mutation
    const { repositoryOwner } = await graphql(`
        query getOwnerId($owner: String!) {
            repositoryOwner(login: $owner) {
                id
            }
        }
    `, { owner });
    const ownerId = repositoryOwner.id;

    // Create the new project (V2) using GraphQL
    const { createProjectV2: { projectV2: project } } = await graphql(`
        mutation createProject($ownerId: ID!, $title: String!, $repoId: ID!) {
            createProjectV2(
                input: {ownerId: $ownerId, title: $title, repositoryId: $repoId}
            ) {
                projectV2 {
                    number
                }
            }
        }
    `, { ownerId, title: projectName, repoId: repository.id }); // We need the repo ID here. Let's add it to the initial query.

    console.log(`Successfully created project "${projectName}" (#${project.number}).`);
    
    const projectNumber = project.number;
    await fs.writeFile(configPath, `PROJECT_NUMBER=${projectNumber}\n`);
    return projectNumber;
  }

  const { projectNumber } = await inquirer.prompt([
    {
      type: 'list',
      name: 'projectNumber',
      message: 'Please select a project:',
      choices: projects,
    },
  ]);

  await fs.writeFile(configPath, `PROJECT_NUMBER=${projectNumber}\n`);
  return projectNumber;
}

async function newIdea(title) {
  const { owner, repo } = await getRepoInfo();
  const projectNumber = await getProjectNumber();
  const graphql = await getAuthenticatedGraphql();

  const { repository } = await graphql(`
    query getProjectId($owner: String!, $repo: String!, $projectNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        project(number: $projectNumber) {
          id
        }
      }
    }
  `, { owner, repo, projectNumber });
  
  const projectId = repository.project.id;

  await graphql(`
    mutation addDraftIssue($projectId: ID!, $title: String!) {
      addProjectDraftIssue(input: {projectId: $projectId, title: $title}) {
        clientMutationId
      }
    }
  `, { projectId, title });

  console.log(`Created a new draft issue with title: "${title}"`);
}

async function newTask(title) {
  const { owner, repo } = await getRepoInfo();
  const projectNumber = await getProjectNumber();
  const octokit = await getOctokit();
  const graphql = await getAuthenticatedGraphql();

  const { data: issue } = await octokit.issues.create({ owner, repo, title });
  console.log(`Created issue #${issue.number}`);

  const { repository } = await graphql(`
    query getColumnId($owner: String!, $repo: String!, $projectNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        project(number: $projectNumber) {
          columns(first: 20) {
            nodes {
              id
              name
            }
          }
        }
      }
    }
  `, { owner, repo, projectNumber });

  const todoColumn = repository.project.columns.nodes.find(c => c.name === 'Todo');
  if (!todoColumn) {
    throw new Error('Could not find a "Todo" column in the project.');
  }

  await graphql(`
    mutation addCard($columnId: ID!, $contentId: ID!) {
      addProjectCard(input: {projectColumnId: $columnId, contentId: $contentId}) {
        clientMutationId
      }
    }
  `, { columnId: todoColumn.id, contentId: issue.node_id });

  console.log(`Added issue #${issue.number} to the "Todo" column.`);
}

async function nextTask() {
  const { owner, repo } = await getRepoInfo();
  const projectNumber = await getProjectNumber();
  const graphql = await getAuthenticatedGraphql();

  const { repository } = await graphql(`
    query getColumnsAndCards($owner: String!, $repo: String!, $projectNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        project(number: $projectNumber) {
          columns(first: 20) {
            nodes {
              id
              name
              cards(first: 1, archivedStates: [NOT_ARCHIVED]) {
                nodes {
                  id
                  content {
                    ... on Issue {
                      id
                      title
                      number
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `, { owner, repo, projectNumber });

  const todoColumn = repository.project.columns.nodes.find(c => c.name === 'Todo');
  const inProgressColumn = repository.project.columns.nodes.find(c => c.name === 'In Progress');

  if (!todoColumn || !inProgressColumn) {
    throw new Error('Could not find "Todo" and/or "In Progress" columns.');
  }
  if (!todoColumn.cards.nodes || todoColumn.cards.nodes.length === 0) {
    throw new Error('No tasks found in the "Todo" column.');
  }

  const card = todoColumn.cards.nodes[0];
  const cardId = card.id;
  const { title: issueTitle, number: issueNumber } = card.content;

  await graphql(`
    mutation moveCard($cardId: ID!, $columnId: ID!) {
      moveProjectCard(input: {cardId: $cardId, columnId: $columnId}) {
        clientMutationId
      }
    }
  `, { cardId, columnId: inProgressColumn.id });
  console.log(`Moved issue #${issueNumber} to "In Progress".`);

  const branchName = issueTitle.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]+/g, '');
  const git = simpleGit();
  
  await git.checkout('main');
  await git.pull();
  await git.checkout(['-b', branchName]);

  console.log(`Created and switched to branch "${branchName}" for issue #${issueNumber}`);
}


// --- Main Execution ---

const [command, ...args] = process.argv.slice(2);

(async () => {
  try {
    await checkAndAddScopes();
    switch (command) {
      case 'new-idea':
        if (!args[0]) throw new Error('A title is required for a new idea.');
        await newIdea(args[0]);
        break;
      case 'new-task':
        if (!args[0]) throw new Error('A title is required for a new task.');
        await newTask(args[0]);
        break;
      case 'next-task':
        await nextTask();
        break;
      default:
        console.log(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
})();
