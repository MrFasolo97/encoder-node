import async from 'async'
import fs from 'node:fs'
const { getFFprobeVideo, hlsEncode, determineOutputs } = import('./uploader/src/encoderHelpers.js')
const config = await import('./config.js')

const vpath = process.argv[2]
const dpath = process.argv[3]

console.log('Source video',vpath)
console.log('Destination path',dpath)

getFFprobeVideo(vpath).then((d) => {
    let { width, height, duration, orientation } = d
    if (!width || !height || !duration || !orientation)
        throw new Error('failed to ffprobe video info')

    // same processing as local encoder
    let outputResolutions = determineOutputs(width,height,config.outputs)

    // Create folders
    fs.mkdirSync(config.dataDir+'/'+dpath)
    for (let r in outputResolutions)
        fs.mkdirSync(config.dataDir+'/'+dpath+'/'+outputResolutions[r]+'p')

    const ops = hlsEncode(
        1, vpath,
        orientation,
        config.encoder,
        config.quality,
        outputResolutions,
        false,
        config.dataDir+'/'+dpath,
        config.threads,
        (id, resolution, p) => {
            console.log('ID '+id+' - '+resolution+'p --- Frames: '+p.frames+'   FPS: '+p.currentFps+'   Progress: '+p.percent.toFixed(3)+'%')
        },
        (id, resolution, e) => {
            console.error(id+' - '+resolution+'p --- Error',e)
        })
    async.parallel(ops,(errors) => {
        if (errors)
            console.log('Error',errors)
        console.log('All done!')
    })
})