import path from 'path';
import fs from 'fs';
import { deriveDriveKey, JWKWallet, arDriveFactory } from 'ardrive-core-js';
import Arweave from 'arweave';

export function findProjectRoot(currentDir: string): string | null {
    let dir = path.resolve(currentDir);
    while (dir !== path.parse(dir).root) {
        if (fs.existsSync(path.join(dir, '.arsync'))) return dir;
        dir = path.dirname(dir);
    }
    if (fs.existsSync(path.join(dir, '.arsync'))) return dir;
    return null;
}

export async function setupDriveKey(
    wallet: JWKWallet, 
    driveId: string, 
    askPassword: () => Promise<string | null>
): Promise<any> {
    const pwd = await askPassword();
    if (!pwd) {
        throw new Error('Password required for private drive operations.');
    }

    // We use arweave.net here (not Goldsky) for two reasons:
    //   1. getDriveSignatureInfo() only makes 1-2 targeted GQL queries, so the
    //      latency difference versus Goldsky is negligible.
    //   2. For V1 drives that have been upgraded (i.e. those with a
    //      "drive-signature" entity on chain), getDriveSignatureInfo() fetches
    //      the encrypted signature payload via a raw HTTP GET to
    //      `${gatewayUrlForArweave(this.arweave)}/${txId}`.  Goldsky is a
    //      pure GQL indexer and cannot serve transaction data — passing it here
    //      would cause that GET to return garbage, producing a wrong drive key
    //      and silently failing to decrypt every entity in the drive.
    const arweaveForDriveKey = Arweave.init({
        host: 'arweave.net',
        port: 443,
        protocol: 'https',
        timeout: 600000
    });

    const arDrive = arDriveFactory({ wallet, arweave: arweaveForDriveKey });
    
    console.log('Verifying password...');
    await arDrive.assertValidPassword(pwd);
    
    console.log('Fetching drive signature info...');
    const owner = await wallet.getAddress();
    
    const driveSignatureInfo = await arDrive.getDriveSignatureInfo({ driveId: driveId as any, owner });
    
    console.log('Deriving drive key...');
    const driveKey = await deriveDriveKey({
        dataEncryptionKey: pwd,
        driveId,
        walletPrivateKey: JSON.stringify(wallet.getPrivateKey()),
        driveSignatureType: driveSignatureInfo.driveSignatureType,
        encryptedSignatureData: driveSignatureInfo.encryptedSignatureData
    });
    
    console.log('Drive key derived successfully!');
    return driveKey;
}