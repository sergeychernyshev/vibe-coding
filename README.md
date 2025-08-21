# Vibe Coding

A collection of shell scripts to automate your GitHub workflow, helping you stay in the zone and focus on coding.

## Scripts

- `new-feature <feature-name>`: Creates a new feature branch from the `main` branch.
- `merge`: Merges the current branch's pull request using the squash and merge strategy, deletes the branch, and restarts the server.
- `next-task`: Fetches the top task from the "Todo" column of your GitHub project, moves it to "In Progress," and creates a new feature branch named after the task.
- `new-task <task-title>`: Creates a new GitHub issue and adds it to the "Todo" column of your project.
- `new-idea <idea-title>`: Creates a new draft issue in your GitHub project.

## Installation

To use these scripts, add the `bin` directory to your `PATH`. You can do this by adding the following line to your shell's configuration file (e.g., `~/.bashrc`, `~/.zshrc`):

```bash
export PATH="/path/to/vibe-coding/bin:$PATH"
```

## Configuration

The first time you run a script that interacts with GitHub Projects (e.g., `next-task`, `new-task`, `new-idea`), you will be prompted to select a project from a list of projects associated with the repository. The selected project number will be saved in a `.github-variables` file in the root of your project. This file will be used for subsequent script executions.
