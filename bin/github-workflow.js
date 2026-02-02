#!/usr/bin/env node

const { execa } = require("execa");
const fs = require("fs/promises");
const path = require("path");
const { graphql } = require("@octokit/graphql");
const { Octokit } = require("@octokit/rest");
const simpleGit = require("simple-git");

// --- Utility Functions ---

async function getGitRoot() {
  try {
    const git = simpleGit();
    const root = await git.revparse(["--show-toplevel"]);
    return root;
  } catch (error) {
    console.error("Error: Not a git repository or git is not installed.");
    process.exit(1);
  }
}

async function getRepoInfo() {
  const gitRoot = await getGitRoot();
  const git = simpleGit(gitRoot);
  let remoteUrl = "";
  try {
    remoteUrl = await git.remote(["get-url", "origin"]);
    if (!remoteUrl) throw new Error();
  } catch (error) {
    throw new Error(
      'Could not get remote URL for "origin". Make sure you have a remote named "origin".',
    );
  }

  const match = remoteUrl
    .trim()
    .match(/github\.com[/:]([\w-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(
      `Could not parse repository owner and name from git remote URL: ${remoteUrl}`,
    );
  }
  return { owner: match[1], repo: match[2] };
}

async function checkAndAddScopes() {
  try {
    const { stdout } = await execa("gh", ["auth", "status"]);
    const lines = stdout.split("\n");
    const tokenLine = lines.find((line) => line.includes("Token scopes:"));

    if (tokenLine && !tokenLine.includes("project")) {
      console.log(
        "The 'project' scope is missing. Attempting to refresh your token...",
      );
      await execa("gh", ["auth", "refresh", "-s", "project"], {
        stdio: "inherit",
      });
      console.log("Token refreshed successfully.");
    } else if (!tokenLine) {
      throw new Error(
        "Could not determine token scopes from `gh auth status` output.",
      );
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "The `gh` command-line tool is not installed or not in your PATH.",
      );
    }
    throw error;
  }
}

async function getAuthToken() {
  try {
    const { stdout: token } = await execa("gh", ["auth", "token"]);
    if (!token)
      throw new Error("The gh auth token command returned an empty value.");
    return token.trim();
  } catch (error) {
    throw new Error(
      "Could not get GitHub authentication token. Please make sure you are logged in with `gh auth login`.",
    );
  }
}

let _graphqlWithAuth;
async function getAuthenticatedGraphql() {
  if (_graphqlWithAuth) return _graphqlWithAuth;
  const token = await getAuthToken();
  _graphqlWithAuth = graphql.defaults({
    headers: { authorization: `token ${token}` },
  });
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

async function getProjectId() {
  let projectId = process.env.GITHUB_PROJECT_ID;

  if (!projectId) {
    try {
      const gitRoot = await getGitRoot();
      const envPath = path.join(gitRoot, ".env");
      const envContent = await fs.readFile(envPath, "utf8");
      const match = envContent.match(/^GITHUB_PROJECT_ID=(.*)$/m);
      if (match) {
        projectId = match[1].trim();
      }
    } catch (error) {
      // Ignore if .env file does not exist or cannot be read
    }
  }

  if (projectId) {
    return projectId;
  }

  console.log("GITHUB_PROJECT_ID environment variable is not set.");
  console.log("Querying GitHub for available projects...");

  const { owner, repo } = await getRepoInfo();
  const graphql = await getAuthenticatedGraphql();

  const { repository } = await graphql(
    `
      query getProjects($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          id
          projectsV2(first: 100, query: "is:open") {
            nodes {
              id
              number
              title
            }
          }
          owner {
            id
          }
        }
      }
    `,
    { owner, repo },
  );

  const projects = repository.projectsV2.nodes;

  if (projects.length === 0) {
    console.error("No open projects found. Please create a project on GitHub.");
  } else {
    console.log("Available Projects:");
    projects.forEach((p) =>
      console.log(`- ID: ${p.id} | Number: ${p.number} | Title: ${p.title}`),
    );
    console.log(
      "\nPlease set GITHUB_PROJECT_ID environment variable (or in .env) to one of the IDs above.",
    );
  }
  process.exit(1);
}

async function newIdea(title) {
  const projectId = await getProjectId();
  const graphql = await getAuthenticatedGraphql();

  const { node: project } = await graphql(
    `
      query getProjectAndStatusField($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            id
            field(name: "Status") {
              __typename
              ... on ProjectV2SingleSelectField {
                id
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `,
    { projectId },
  );

  if (!project) throw new Error(`Could not find Project with ID ${projectId}.`);

  const statusField = project.field;
  if (!statusField || statusField.__typename !== "ProjectV2SingleSelectField") {
    throw new Error(
      'Project is missing the "Status" field or it is not a single select field.',
    );
  }

  const backlogOption = statusField.options.find((o) => o.name === "Backlog");
  if (!backlogOption) {
    throw new Error(
      'Project is missing the "Backlog" option in the "Status" field.',
    );
  }

  const {
    addProjectV2DraftIssue: { projectItem },
  } = await graphql(
    `
      mutation addDraft($projectId: ID!, $title: String!) {
        addProjectV2DraftIssue(
          input: { projectId: $projectId, title: $title }
        ) {
          projectItem {
            id
          }
        }
      }
    `,
    { projectId: project.id, title },
  );
  console.log(`Created a new draft issue with title: "${title}"`);

  await graphql(
    `
      mutation updateItemStatus(
        $projectId: ID!
        $itemId: ID!
        $fieldId: ID!
        $optionId: String!
      ) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { singleSelectOptionId: $optionId }
          }
        ) {
          projectV2Item {
            id
          }
        }
      }
    `,
    {
      projectId: project.id,
      itemId: projectItem.id,
      fieldId: statusField.id,
      optionId: backlogOption.id,
    },
  );
  console.log(`Set status for idea "${title}" to "Backlog".`);
}

async function newTask(title) {
  const { owner, repo } = await getRepoInfo();
  const projectId = await getProjectId();
  const octokit = await getOctokit();
  const graphql = await getAuthenticatedGraphql();

  const { data: issue } = await octokit.issues.create({ owner, repo, title });
  console.log(`Created issue #${issue.number}`);

  const { node: project } = await graphql(
    `
      query getProjectAndStatusField($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            id
            field(name: "Status") {
              __typename
              ... on ProjectV2SingleSelectField {
                id
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `,
    { projectId },
  );

  if (!project) throw new Error(`Could not find Project with ID ${projectId}.`);

  const statusField = project.field;
  if (!statusField || statusField.__typename !== "ProjectV2SingleSelectField") {
    throw new Error(
      'Project is missing the "Status" field or it is not a single select field.',
    );
  }

  const todoOption = statusField.options.find((o) => o.name === "Todo");
  if (!todoOption) {
    throw new Error(
      'Project is missing the "Todo" option in the "Status" field.',
    );
  }

  const {
    addProjectV2ItemById: { item: projectItem },
  } = await graphql(
    `
      mutation addItem($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(
          input: { projectId: $projectId, contentId: $contentId }
        ) {
          item {
            id
          }
        }
      }
    `,
    { projectId: project.id, contentId: issue.node_id },
  );
  console.log(`Added issue #${issue.number} to the project.`);

  await graphql(
    `
      mutation updateItemStatus(
        $projectId: ID!
        $itemId: ID!
        $fieldId: ID!
        $optionId: String!
      ) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { singleSelectOptionId: $optionId }
          }
        ) {
          projectV2Item {
            id
          }
        }
      }
    `,
    {
      projectId: project.id,
      itemId: projectItem.id,
      fieldId: statusField.id,
      optionId: todoOption.id,
    },
  );
  console.log(`Set status for issue #${issue.number} to "Todo".`);
}

async function nextTask() {
  const projectId = await getProjectId();
  const graphql = await getAuthenticatedGraphql();

  const { node: project } = await graphql(
    `
      query getProjectData($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            id
            field(name: "Status") {
              __typename
              ... on ProjectV2Field {
                name
                dataType
              }
              ... on ProjectV2IterationField {
                name
              }
              ... on ProjectV2SingleSelectField {
                id
                options {
                  id
                  name
                }
              }
            }
            items(first: 50, orderBy: { field: POSITION, direction: ASC }) {
              nodes {
                id
                fieldValueByName(name: "Status") {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    optionId
                  }
                }
                content {
                  ... on Issue {
                    title
                    number
                    body
                  }
                  ... on DraftIssue {
                    title
                    body
                  }
                }
              }
            }
          }
        }
      }
    `,
    { projectId },
  );

  if (!project) throw new Error(`Could not find Project with ID ${projectId}.`);
  const statusField = project.field;
  if (!statusField) throw new Error('Project is missing the "Status" field.');

  const todoOption = statusField.options.find((o) => o.name === "Todo");
  const inProgressOption = statusField.options.find(
    (o) => o.name === "In Progress",
  );
  if (!todoOption || !inProgressOption)
    throw new Error(
      'Project is missing "Todo" or "In Progress" options in the "Status" field.',
    );

  const todoItem = project.items.nodes.find(
    (item) => item.fieldValueByName?.optionId === todoOption.id && item.content,
  );
  if (!todoItem) throw new Error('No tasks found in the "Todo" column.');

  const { title: issueTitle, number: issueNumber, body: issueBody } = todoItem.content;

  await graphql(
    `
      mutation updateItemStatus(
        $projectId: ID!
        $itemId: ID!
        $fieldId: ID!
        $optionId: String!
      ) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { singleSelectOptionId: $optionId }
          }
        ) {
          projectV2Item {
            id
          }
        }
      }
    `,
    {
      projectId: project.id,
      itemId: todoItem.id,
      fieldId: statusField.id,
      optionId: inProgressOption.id,
    },
  );
  console.log(`Moved task "${issueTitle}" to "In Progress".`);

  if (issueBody) {
    console.log("\nTask Description:");
    console.log(issueBody);
    console.log("\n");
  }

  const branchName = issueTitle
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]+/g, "");
  const git = simpleGit();
  await git.checkout("main");
  await git.pull();
  await git.checkout(["-b", branchName]);
  console.log(`Created and switched to branch "${branchName}"`);
}

// --- Main Execution ---

(async () => {
  try {
    await checkAndAddScopes();
    const [command, ...args] = process.argv.slice(2);
    let title = args.join(" ");

    if ((command === "new-idea" || command === "new-task") && title) {
      title = title.charAt(0).toUpperCase() + title.slice(1);
    }

    switch (command) {
      case "new-idea":
        if (!title) throw new Error("A title is required for a new idea.");
        await newIdea(title);
        break;
      case "new-task":
        if (!title) throw new Error("A title is required for a new task.");
        await newTask(title);
        break;
      case "next-task":
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