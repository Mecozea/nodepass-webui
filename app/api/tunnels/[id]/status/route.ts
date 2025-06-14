import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { TunnelStatus } from "@prisma/client";
import { convertBigIntToNumber } from "@/lib/utils";
import { proxyFetch } from '@/lib/utils/proxy-fetch';
import { logger } from '@/lib/server/logger';

// PATCH /api/tunnels/[id]/status - 更新隧道状态（启动/停止/重启）
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const resolvedParams = await params;
    const tunnelId = parseInt(resolvedParams.id);
    if (isNaN(tunnelId)) {
      return NextResponse.json(
        { error: "无效的隧道ID" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { action } = body;

    // 验证 action 参数
    if (!['start', 'stop', 'restart'].includes(action)) {
      return NextResponse.json(
        { error: "无效的操作，只支持 start、stop、restart" },
        { status: 400 }
      );
    }

    // 查找隧道及其关联的端点信息
    const tunnel = await prisma.tunnel.findUnique({
      where: { id: tunnelId },
      include: {
        endpoint: true
      }
    });

    if (!tunnel) {
      return NextResponse.json(
        { error: "隧道不存在" },
        { status: 404 }
      );
    }

    if (!tunnel.instanceId) {
      return NextResponse.json(
        { error: "隧道实例ID不存在" },
        { status: 400 }
      );
    }

    try {
      // 构建 NodePass API 请求 URL
      const apiUrl = `${tunnel.endpoint.url}${tunnel.endpoint.apiPath}/instances/${tunnel.instanceId}`;
      
      logger.info(`[API] 正在调用 NodePass API: ${apiUrl} - 操作: ${action}`);

      // 调用 NodePass API，使用 proxyFetch 支持系统代理和双栈 IP
      const nodepassResponse = await proxyFetch(apiUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': tunnel.endpoint.apiKey
        },
        body: JSON.stringify({ action }),
        timeout: 10000 // 10秒超时
      });

      if (!nodepassResponse.ok) {
        const errorText = await nodepassResponse.text();
        throw new Error(`NodePass API 响应错误: ${nodepassResponse.status} - ${errorText}`);
      }
      
      const nodepassData = await nodepassResponse.json();

      // 记录成功日志
      await prisma.tunnelOperationLog.create({
        data: {
          tunnelId: tunnelId,
          tunnelName: tunnel.name,
          action: action,
          status: "success",
          message: `${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}隧道成功`
        }
      });

      // 返回成功响应
      return NextResponse.json({
        success: true,
        tunnel: convertBigIntToNumber(tunnel.id),
        nodepassData: convertBigIntToNumber(nodepassData)
      });

    } catch (apiError: any) {
      logger.error('调用 NodePass API 失败:', {
        error: apiError.message,
        tunnelId,
        action,
        url: tunnel.endpoint.url
      });

      // 记录失败日志
      await prisma.tunnelOperationLog.create({
        data: {
          tunnelId: tunnelId,
          tunnelName: tunnel.name,
          action: action,
          status: "error",
          message: `${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}隧道失败: ${apiError.message}`
        }
      });

      // 返回错误响应
      return NextResponse.json({
        success: false,
        error: '调用 NodePass API 失败',
        message: apiError.message
      }, { status: 500 });
    }

  } catch (error) {
    logger.error("更新隧道状态失败:", error);
    return NextResponse.json(
      { error: "更新隧道状态失败" },
      { status: 500 }
    );
  }
} 