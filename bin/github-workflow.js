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
        if (!remoteUrl) throw new Error();
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
            console.log("The 'project' scope is missing. Attempting to refresh your token...");
            await execa('gh', ['auth', 'refresh', '-s', 'project'], { stdio: 'inherit' });
            console.log("Token refreshed successfully.");
        } else if (!tokenLine) {
            throw new Error("Could not determine token scopes from `gh auth status` output.");
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
             throw new Error('The `gh` command-line tool is not installed or not in your PATH.');
        }
        throw error;
    }
}

async function getAuthToken() {
    try {
        const { stdout: token } = await execa('gh', ['auth', 'token']);
        if (!token) throw new Error('The gh auth token command returned an empty value.');
        return token.trim();
    } catch (error) {
        throw new Error('Could not get GitHub authentication token. Please make sure you are logged in with `gh auth login`.');
    }
}

let _graphqlWithAuth;
async function getAuthenticatedGraphql() {
  if (_graphqlWithAuth) return _graphqlWithAuth;
  const token = await getAuthToken();
  _graphqlWithAuth = graphql.defaults({ headers: { authorization: `token ${token}` } });
  return _graphqlWithAuth;
}

let _octokit;
async function getOctokit() {
    if (_octokit) return _octokit;
    const token = await getAuthToken();
    _octokit = new Octokit({ auth: token });
    return _octokit;
}

// --- Core Logic ---

async function createProjectAndSetupStatuses(owner, repo, projectName, ownerId, repoId) {
    const graphql = await getAuthenticatedGraphql();
    
    const { createProjectV2: { projectV2 } } = await graphql(`
        mutation createProject($ownerId: ID!, $title: String!, $repoId: ID!) {
            createProjectV2(input: {ownerId: $ownerId, title: $title, repositoryId: $repoId}) {
                projectV2 { id, number }
            }
        }
    `, { ownerId, title: projectName, repoId });
    console.log(`Successfully created project "${projectName}" (#${projectV2.number}).`);

    const { createProjectV2Field: { projectV2Field } } = await graphql(`
        mutation createStatusField($projectId: ID!) {
            createProjectV2Field(input: { projectId: $projectId, dataType: SINGLE_SELECT, name: "Status" }) {
                projectV2Field { id }
            }
        }
    `, { projectId: projectV2.id });
    const statusFieldId = projectV2Field.id;
    console.log('Created "Status" field.');

    await graphql(`
        mutation addStatusOptions($projectId: ID!, $fieldId: ID!) {
            todo: addProjectV2FieldOption(input: {projectId: $projectId, fieldId: $fieldId, name: "Todo"}) { clientMutationId }
            inProgress: addProjectV2FieldOption(input: {projectId: $projectId, fieldId: $fieldId, name: "In Progress"}) { clientMutationId }
            done: addProjectV2FieldOption(input: {projectId: $projectId, fieldId: $fieldId, name: "Done"}) { clientMutationId }
        }
    `, { projectId: projectV2.id, fieldId: statusFieldId });
    console.log('Added "Todo", "In Progress", and "Done" options to "Status" field.');

    return projectV2.number;
}

async function getProjectNumber() {
  const gitRoot = await getGitRoot();
  const configPath = path.join(gitRoot, CONFIG_FILE);

  try {
    const data = await fs.readFile(configPath, 'utf8');
    const match = data.match(/PROJECT_NUMBER=(\d+)/);
    if (match) return parseInt(match[1], 10);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const { owner, repo } = await getRepoInfo();
  const graphql = await getAuthenticatedGraphql();
  const { repository } = await graphql(`
    query getProjects($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        id
        projectsV2(first: 100, query: "is:open") { nodes { number, title } }
        owner { id }
      }
    }
  `, { owner, repo });

  const projects = repository.projectsV2.nodes.map(p => ({ name: `${p.number} ${p.title}`, value: p.number }));

  if (projects.length === 0) {
    const { createNew } = await inquirer.prompt([{ type: 'confirm', name: 'createNew', message: 'No open projects found. Would you like to create one?', default: true }]);
    if (!createNew) {
      console.log('Aborting. No project selected.');
      process.exit(0);
    }
    const defaultProjectName = repo.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const { projectName } = await inquirer.prompt([{ type: 'input', name: 'projectName', message: 'Enter the name for the new project:', default: defaultProjectName, validate: i => !!i }]);
    
    const projectNumber = await createProjectAndSetupStatuses(owner, repo, projectName, repository.owner.id, repository.id);
    await fs.writeFile(configPath, `PROJECT_NUMBER=${projectNumber}\n`);
    return projectNumber;
  }

  const { projectNumber } = await inquirer.prompt([{ type: 'list', name: 'projectNumber', message: 'Please select a project:', choices: projects }]);
  await fs.writeFile(configPath, `PROJECT_NUMBER=${projectNumber}\n`);
  return projectNumber;
}

async function newIdea(title) {
  const { owner, repo } = await getRepoInfo();
  const projectNumber = await getProjectNumber();
  const graphql = await getAuthenticatedGraphql();

  const { repository } = await graphql(`
    query getProjectV2Id($owner: String!, $repo: String!, $projectNumber: Int!) {
      repository(owner: $owner, name: $repo) { projectV2(number: $projectNumber) { id } }
    }
  `, { owner, repo, projectNumber });
  if (!repository.projectV2) throw new Error(`Could not find Project (V2) with number ${projectNumber}.`);
  
  await graphql(`
    mutation addDraft($projectId: ID!, $title: String!) {
      addProjectV2DraftIssue(input: {projectId: $projectId, title: $title}) { projectItem { id } }
    }
  `, { projectId: repository.projectV2.id, title });
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
    query getProjectV2Id($owner: String!, $repo: String!, $projectNumber: Int!) {
      repository(owner: $owner, name: $repo) { projectV2(number: $projectNumber) { id } }
    }
  `, { owner, repo, projectNumber });
  if (!repository.projectV2) throw new Error(`Could not find Project (V2) with number ${projectNumber}.`);

  await graphql(`
    mutation addItem($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { item { id } }
    }
  `, { projectId: repository.projectV2.id, contentId: issue.node_id });
  console.log(`Added issue #${issue.number} to the project.`);
}

async function nextTask() {
  const { owner, repo } = await getRepoInfo();
  const projectNumber = await getProjectNumber();
  const graphql = await getAuthenticatedGraphql();

  const { repository } = await graphql(`
    query getProjectData($owner: String!, $repo: String!, $projectNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        projectV2(number: $projectNumber) {
          id
          field(name: "Status") {
            ... on ProjectV2SingleSelectField { id, options { id, name } }
          }
          items(first: 50, orderBy: {field: POSITION, direction: ASC}) {
            nodes {
              id
              fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId } }
              content {
                ... on Issue { title, number }
                ... on DraftIssue { title }
              }
            }
          }
        }
      }
    }
  `, { owner, repo, projectNumber });

  const project = repository.projectV2;
  if (!project) throw new Error(`Could not find Project (V2) with number ${projectNumber}.`);
  const statusField = project.field;
  if (!statusField) throw new Error('Project is missing the "Status" field.');

  const todoOption = statusField.options.find(o => o.name === 'Todo');
  const inProgressOption = statusField.options.find(o => o.name === 'In Progress');
  if (!todoOption || !inProgressOption) throw new Error('Project is missing "Todo" or "In Progress" options in the "Status" field.');

  const todoItem = project.items.nodes.find(item => item.fieldValueByName?.optionId === todoOption.id && item.content);
  if (!todoItem) throw new Error('No tasks found in the "Todo" column.');

  const { title: issueTitle, number: issueNumber } = todoItem.content;

  await graphql(`
    mutation updateItemStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) {
        projectV2Item { id }
      }
    }
  `, { projectId: project.id, itemId: todoItem.id, fieldId: statusField.id, optionId: inProgressOption.id });
  console.log(`Moved task "${issueTitle}" to "In Progress".`);

  const branchName = issueTitle.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]+/g, '');
  const git = simpleGit();
  await git.checkout('main');
  await git.pull();
  await git.checkout(['-b', branchName]);
  console.log(`Created and switched to branch "${branchName}"`);
}

// --- Main Execution ---

(async () => {
  try {
    await checkAndAddScopes();
    const [command, ...args] = process.argv.slice(2);
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