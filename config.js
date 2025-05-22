import path from 'path'

const config = {
    authIdentifier: 'oneloveipfs_login',
    encoder: 'h264_videotoolbox',
    quality: '-q:v 54',
    threads: 8,
    outputs: [2160,1080,720],
    maxSizeMb: 1024,
    username: '',
    network: 'hive',
    key: '',
    blockchainAPI: 'https://techcoderx.com',
    tusdEndpoint: 'http://localhost:1080/files',
    uploadEndpoint: 'http://localhost:3000',
    uploadThreads: 5,
    dataDir: process.cwd()+'/outputs'
}
export default config