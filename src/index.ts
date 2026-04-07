#!/usr/bin/env node

import { Command } from 'commander';
import { SyncDB } from './db';
import { runSync } from './sync';
import { runLs } from './ls';
import { runDownload } from './download';
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
  .action(async (driveId, dir, options) => {
    const projectPath = path.resolve(dir);
    console.log(`Initializing arsync in ${projectPath}`);
    
    const db = new SyncDB(projectPath);
    await db.setConfig('drive_id', driveId);
    if (options.wallet) {
        await db.setConfig('wallet_path', path.resolve(options.wallet));
    }

    await doSync(db);
  });

program
  .command('update')
  .description('Fetch the latest metadata changes from ArDrive')
  .argument('[dir]', 'Directory to update (default: current)', '.')
  .action(async (dir) => {
    const projectPath = path.resolve(dir);
    const db = new SyncDB(projectPath);
    await doSync(db);
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

async function doSync(db: SyncDB) {
    try {
        await runSync(db, async () => {
            const answers = await inquirer.prompt([{
                type: 'password',
                name: 'password',
                message: 'Enter ArDrive password for private drive:'
            }]);
            return answers.password;
        });
    } catch (err: any) {
        console.error('Error during sync:', err.message);
    }
}

program.parse();