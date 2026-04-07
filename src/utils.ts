import path from 'path';
import fs from 'fs';
import { deriveDriveKey, JWKWallet } from 'ardrive-core-js';

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
    arDrive: any, 
    wallet: JWKWallet, 
    driveId: string, 
    askPassword: () => Promise<string | null>
): Promise<any> {
    const pwd = await askPassword();
    if (!pwd) {
        throw new Error('Password required for private drive operations.');
    }
    
    console.log('Verifying password...');
    await arDrive.assertValidPassword(pwd);
    
    console.log('Deriving drive key...');
    const owner = await wallet.getAddress();
    const driveSignatureInfo = await arDrive.getDriveSignatureInfo({ driveId: driveId as any, owner });
    
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