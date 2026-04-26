// 内容安全审核云函数
// 支持：图片安全检测、视频安全检测、文本安全检测
// 所有调用都需要鉴权（必须有 OPENID）

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

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
        const result = await cloud.openapi.security.imgSecCheck({
          media: {
            contentType: 'image/png',
            value: fileBuffer
          }
        })
        return {
          pass: result.errCode === 0,
          errCode: result.errCode,
          errMsg: result.errMsg || '审核通过'
        }
      }

      return { pass: true, errMsg: '无文件内容' }

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
        pass: true,
        traceId: result.traceId,
        errMsg: '视频已提交审核，异步处理中'
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
        pass: true,
        traceId: result.traceId,
        errMsg: '图片已提交审核'
      }
    }

    return { pass: true, errMsg: '未知检测类型' }

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
      pass: true,
      errCode: err.errCode || -1,
      errMsg: '内容安全服务暂不可用，已跳过检测'
    }
  }
}
