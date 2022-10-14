const fs = require('fs')
const io = require('socket.io-client')
const axios = require('axios')
const async = require('async')
const wget = require('wget-improved')
const tus = require('tus-js-client')
const hivecryptPro = require('./uploader/src/hivecryptPro.js')
const config = require('./config.js')
const { getFFprobeVideo, getHlsBw, hlsEncode } = require('./uploader/src/encoderHelpers.js')
const MB = 1048576

let access_token = ''
let uploaded = 0
let processed = 0

let socket = io.connect(config.uploadEndpoint+'/encoderdaemon')
socket.on('message',(msg) => {
    console.log('message',msg)
    generateMessageToSign(config.username,config.network,(e,signThis) => {
        if (e)
            throw new Error(e)
        let signature = hivecryptPro.Signature.create(hivecryptPro.sha256(signThis),config.key).customToString()
        let payload = signThis+':'+signature
        console.log('Auth payload',payload)
        axios.post(config.uploadEndpoint+'/loginsig',payload,{ headers: { 'Content-Type': 'text/plain' }}).then((authresponse) => {
            if (authresponse.data && authresponse.data.access_token) {
                console.log('access_token',authresponse.data.access_token)
                access_token = authresponse.data.access_token
                socket.emit('auth',{
                    access_token: authresponse.data.access_token,
                    keychain: 'true',
                    encoder: config.encoder,
                    quality: config.quality,
                    outputs: config.outputs,
                    maxSize: config.maxSizeMb*MB
                })
            }
        }).catch((e) => {
            console.log('/loginsig error',e.response.data)
        })
    })
})
socket.on('job',(newjob) => {
    console.log('New job',newjob)
    uploaded = 0
    processed = 0
    let download = wget.download(config.tusdEndpoint+'/'+newjob.id,newjob.id)
    download.on('error', (err) => {
        console.log('Download failed',newjob.id,err)
    })
    download.on('start', (size) => {
        console.log('Downloading',newjob.id,size)
        socket.emit('jobbegin',{
            id: newjob.id,
            step: 'fetch',
            size: size
        })
    })
    download.on('end', () => {
        console.log('Processing',newjob.id)
        getFFprobeVideo(newjob.id).then((d) => {
            let { width, height, duration, orientation } = d
            if (!width || !height || !duration || !orientation)
                return socket.emit('joberror',{ id: newjob.id, error: 'remote encoder failed to ffprobe video info' })

            // same processing as local encoder
            let outputResolutions = []
            let sedge = Math.min(width,height)
            for (let q in config.outputs)
                if (getHlsBw(config.outputs[q]) && sedge >= config.outputs[q])
                    outputResolutions.push(config.outputs[q])
            if (outputResolutions.length === 0)
                outputResolutions.push(config.outputs[config.outputs.length-1])
            outputResolutions = outputResolutions.sort((a,b) => a-b)

            // Create folders
            fs.mkdirSync(config.dataDir+'/'+newjob.id)
            for (let r in outputResolutions)
                fs.mkdirSync(config.dataDir+'/'+newjob.id+'/'+outputResolutions[r]+'p')

            const ops = hlsEncode(
                newjob.id, newjob.id,
                orientation,
                config.encoder,
                config.quality,
                outputResolutions,
                newjob.createSprite,
                config.dataDir+'/'+newjob.id,
                config.threads,
                (id, resolution, p) => {
                    socket.emit('jobprogress',{
                        id: id,
                        job: 'encode',
                        resolution: resolution,
                        frames: p.frames,
                        fps: p.currentFps,
                        progress: p.percent
                    })
                    console.log('ID '+id+' - '+resolution+'p --- Frames: '+p.frames+'   FPS: '+p.currentFps+'   Progress: '+p.percent.toFixed(3)+'%')
                },
                (id, resolution, e) => {
                    console.error(id+' - '+resolution+'p --- Error',e)
                    socket.emit('joberror',{ id: id, error: resolution + 'p resolution encoding failed' })
                })
            socket.emit('jobbegin',{
                id: newjob.id,
                step: 'encode',
                outputs: outputResolutions
            })
            async.parallel(ops,(e) => {
                // post processing
                let total = 0
                let sprite = false
                for (let o in outputResolutions)
                    total += fs.readdirSync(config.dataDir+'/'+newjob.id+'/'+outputResolutions[o]+'p').length
                if (fs.existsSync(config.dataDir+'/'+newjob.id+'/sprite.jpg')) {
                    total++
                    sprite = true
                }
                socket.emit('jobbegin',{
                    id: newjob.id,
                    step: 'upload',
                    outputs: outputResolutions,
                    totalFiles: total
                })
                uploaded = total
                uploadOutputs(newjob.id,outputResolutions,async (success) => {
                    console.log(newjob.id,'output upload success',success)
                    if (sprite)
                        success = await uploadOne(newjob.id,'sprite',config.dataDir+'/'+newjob.id+'/sprite.jpg')
                    console.log(newjob.id,'sprite upload success',success)
                })
            })
        })
    })
    download.on('progress', (progress) => {
        console.log('Download progress',newjob.id,progress)
        socket.emit('jobprogress',{
            id: newjob.id,
            step: 'fetch',
            progress: progress
        })
    })
})
socket.on('status',(status) => {
    console.log('status',status)
})
socket.on('result',(result) => {
    console.log('result',result)
    if (result.method === 'auth' && result.success)
        socket.emit('status')
    else if (result.method === 'hlsencode' && result.success) {
        processed++
        if (uploaded === processed) {
            uploaded = 0
            processed = 0
            socket.emit('jobbegin',{
                id: result.id,
                step: 'postupload'
            })
        }
    }
})
socket.on('error',(e) => {
    console.log('error',e)
})

function generateMessageToSign (username,network,cb) {
    // Generate text for user to sign
    // using latest block id
    let message = username+':'+config.authIdentifier+':'+network+':'
    switch (network) {
        case 'hive':
            axios.post(config.blockchainAPI,{
                id: 1,
                jsonrpc: '2.0',
                method: 'condenser_api.get_dynamic_global_properties',
                params: []
            }).then((r) => {
                if (r.data && r.data.result) {
                    message += r.data.result.head_block_number+':'+r.data.result.head_block_id
                    cb(null,message)
                } else if (r.data && r.data.error)
                    cb(r.data.error.message)
            }).catch(e => cb(e.toString()))
            break
        case 'dtc':
            axios.get(config.blockchainAPI+'/count').then((r) => {
                if (r.data && r.data.count) {
                    message += r.data.count-1
                    message += ':'
                    axios.get(config.blockchainAPI+'/block/'+(r.data.count-1)).then((b) => {
                        if (b.data && b.data.hash) {
                            message += b.data.hash
                            cb(null,message)
                        }
                    }).catch(e => cb(e.toString()))
                }
            }).catch(e => cb(e.toString()))
            break
    }
}

async function uploadOutputs(id, outputs = [], cb = () => {}) {
    if (outputs.length === 0)
        return cb(true)
    let r = await uploadOutput(id, outputs[0])
    outputs.shift()
    if (!r)
        return cb(false)
    uploadOutputs(id,outputs,cb)
}

async function uploadOutput(id, output) {
    let files = fs.readdirSync(config.dataDir+'/'+id+'/'+output+'p')
    for (let f in files)
        try {
            await uploadOne(id,output,config.dataDir+'/'+id+'/'+output+'p/'+files[f],files[f])
        } catch {
            return false
        }
    return true
}

function uploadOne(id, output, dir = '', file = '') {
    return new Promise((rs,rj) => {
        let upload = new tus.Upload(fs.createReadStream(dir),{
            endpoint: config.tusdEndpoint,
            retryDelays: [0,3000,5000,10000,20000],
            parallelUploads: config.uploadThreads,
            headers: {
                'Authorization': 'Bearer '+Buffer.from(JSON.stringify({keychain: true})).toString('base64').replace(/={1,2}$/, '')+'.'+access_token
            },
            metadata: {
                type: 'hlsencode',
                encodeID: id,
                idx: file.endsWith('.ts') ? parseInt(file.replace('.ts','')) : -1,
                output: output
            },
            onError: (e) => {
                console.log('tus error',e.toString())
                rj(e)
            },
            onProgress: (bu,bt) => {
                let progressPercent = Math.round((bu / bt) * 100)
                console.log(id,output,file,'progress: ' + progressPercent + '%')
            },
            onSuccess: () => {
                rs(true)
            }
        })
        upload.findPreviousUploads().then((p) => {
            if (p.length > 0)
                upload.resumeFromPreviousUpload(p[0])
            upload.start()
        })
    })
}