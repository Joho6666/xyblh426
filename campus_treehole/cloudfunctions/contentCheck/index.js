// 内容安全审核云函数
// 支持：图片安全检测、视频安全检测、文本安全检测
// 所有调用都需要鉴权（必须有 OPENID）

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/**
 * imgSecCheck 的 media.contentType 必须与二进制内容一致。
 * 此前固定传 image/png，用户相册/拍照多为 JPEG，易导致微信返回「展示异常」等误判。
 */
function guessImageContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return 'image/jpeg'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp'
  }
  return 'image/jpeg'
}

exports.main = async (event, context) => {
  // 鉴权：必须有合法的 OPENID
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) {
    return { pass: false, errCode: -1, errMsg: '未授权访问' }
  }

  const { type, fileID, filePath, text } = event

  try {
    if (type === 'text') {
      // ========== 文本内容安全检测 ==========
      const result = await cloud.openapi.security.msgSecCheck({
        openid: OPENID,
        scene: 2,
        version: 2,
        content: text
      })

      if (result.result && result.result.suggest === 'risky') {
        return {
          pass: false,
          errCode: 87014,
          errMsg: '文本内容包含违规信息'
        }
      }
      return { pass: true, errCode: 0, errMsg: '文本审核通过' }

    } else if (type === 'image') {
      // ========== 图片内容安全检测 ==========
      // 注意：云函数无法读取小程序本地 filePath，调用方必须先 wx.cloud.uploadFile 拿到 fileID 再传入
      if (!fileID) {
        return { pass: false, errCode: -1, errMsg: '缺少 fileID 参数' }
      }
      const res = await cloud.downloadFile({ fileID })
      const fileBuffer = res.fileContent

      if (fileBuffer) {
        const contentType = guessImageContentType(fileBuffer)
        const result = await cloud.openapi.security.imgSecCheck({
          media: {
            contentType,
            value: fileBuffer
          }
        })
        return {
          pass: result.errCode === 0,
          errCode: result.errCode,
          errMsg: result.errMsg || '审核通过'
        }
      }

      return { pass: false, errCode: -1, errMsg: '图片文件读取失败' }

    } else if (type === 'video') {
      // ========== 视频内容安全检测 ==========
      const result = await cloud.openapi.security.mediaCheckAsync({
        mediaUrl: fileID || filePath,
        mediaType: 2,
        version: 2,
        scene: 1,
        openid: OPENID
      })

      return {
        pass: false,
        traceId: result.traceId,
        errCode: -1,
        errMsg: '视频审核为异步流程，当前接口不提供同步放行结果'
      }

    } else if (type === 'imageUrl') {
      // ========== 通过URL检测图片 ==========
      const result = await cloud.openapi.security.mediaCheckAsync({
        mediaUrl: fileID,
        mediaType: 1,
        version: 2,
        scene: 1,
        openid: OPENID
      })

      return {
        pass: false,
        traceId: result.traceId,
        errCode: -1,
        errMsg: '图片 URL 审核为异步流程，当前接口不提供同步放行结果'
      }
    }

    return { pass: false, errCode: -1, errMsg: '未知检测类型' }

  } catch (err) {
    console.error('内容安全检测异常:', err)
    if (err.errCode === 87014) {
      return {
        pass: false,
        errCode: 87014,
        errMsg: '内容含有违法违规信息，请更换后重试'
      }
    }
    return {
      pass: false,
      errCode: err.errCode || -1,
      errMsg: '内容安全服务异常，请稍后重试'
    }
  }
}
