#!/usr/bin/env node

import { Command } from 'commander';
import { SyncDB } from './db';
import { runSync } from './sync';
import { runLs } from './ls';
import { runDownload } from './download';
import { runDiagnose } from './diagnose';
import { runRetrySkipped } from './retry_skipped';
import { findProjectRoot } from './utils';
import inquirer from 'inquirer';
import path from 'path';

const program = new Command();

program
  .name('arsync')
  .description('SQLite-backed CLI for syncing massive ArDrive drives')
  .version('1.0.0');

program
  .command('checkout')
  .description('Initialize a directory and fetch ArFS drive metadata')
  .argument('<driveId>', 'The ArFS Drive ID to sync')
  .argument('[dir]', 'Directory to initialize (default: current)', '.')
  .option('-w, --wallet <path>', 'Path to Arweave wallet JSON file')
  .option('--debug', 'Print verbose per-transaction debug output during sync')
  .action(async (driveId, dir, options) => {
    const projectPath = path.resolve(dir);
    console.log(`Initializing arsync in ${projectPath}`);
    
    const db = new SyncDB(projectPath);
    await db.setConfig('drive_id', driveId);
    if (options.wallet) {
        await db.setConfig('wallet_path', path.resolve(options.wallet));
    }

    await doSync(db, options.debug ?? false);
  });

program
  .command('update')
  .description('Fetch the latest metadata changes from ArDrive')
  .argument('[dir]', 'Directory to update (default: current)', '.')
  .option('--debug', 'Print verbose per-transaction debug output during sync')
  .action(async (dir, options) => {
    const projectPath = path.resolve(dir);
    const db = new SyncDB(projectPath);
    await doSync(db, options.debug ?? false);
  });

program
  .command('ls')
  .description('List files and folders in the synchronized drive')
  .argument('[path]', 'Path to list (default: current)', '.')
  .action(async (targetPath) => {
    try {
        await runLs(targetPath);
    } catch (err: any) {
        console.error('Error during ls:', err.message);
    }
  });

program
  .command('download')
  .description('Download missing files from ArDrive to the local directory')
  .argument('[path]', 'Path to download (default: current)', '.')
  .action(async (targetPath) => {
    try {
        await runDownload(targetPath, async () => {
            const answers = await inquirer.prompt([{
                type: 'password',
                name: 'password',
                message: 'Enter ArDrive password for private file download:'
            }]);
            return answers.password;
        });
    } catch (err: any) {
        console.error('Error during download:', err.message);
    }
  });

program
  .command('retry-skipped')
  .description('Retry all previously-failed metadata transaction fetches')
  .argument('[dir]', 'Project directory containing the .arsync folder (default: current)', '.')
  .action(async (dir) => {
    const projectPath = path.resolve(dir);
    const root = findProjectRoot(projectPath);
    if (!root) {
        console.error(`No .arsync project found at or above: ${projectPath}`);
        process.exit(1);
    }
    const db = new SyncDB(root);
    try {
        await runRetrySkipped(db, async () => {
            const answers = await inquirer.prompt([{
                type: 'password',
                name: 'password',
                message: 'Enter ArDrive password for private drive:'
            }]);
            return answers.password;
        });
    } catch (err: any) {
        console.error('Error during retry-skipped:', err.message);
        process.exit(1);
    }
  });

program
  .command('diagnose')
  .description('Investigate why a specific entity (file or folder) is missing from the local database')
  .argument('<entityId>', 'The ArFS entity ID (folder ID or file ID) to investigate')
  .argument('[dir]', 'Project directory containing the .arsync folder (default: current)', '.')
  .action(async (entityId, dir) => {
    const projectPath = path.resolve(dir);
    const root = findProjectRoot(projectPath);
    if (!root) {
        console.error(`No .arsync project found at or above: ${projectPath}`);
        console.error('Run "arsync checkout <driveId>" first, or specify the project directory.');
        process.exit(1);
    }
    const db = new SyncDB(root);
    try {
        await runDiagnose(entityId, db);
    } catch (err: any) {
        console.error('Error during diagnose:', err.message);
    }
  });

async function doSync(db: SyncDB, debug: boolean) {
    try {
        await runSync(db, async () => {
            const answers = await inquirer.prompt([{
                type: 'password',
                name: 'password',
                message: 'Enter ArDrive password for private drive:'
            }]);
            return answers.password;
        }, debug);
    } catch (err: any) {
        console.error('Sync aborted:', err.message);
        process.exit(1);
    }
}

program.parse();
