using System.Text.Json;

namespace Tsinghua;

// Installation failures never contain account data. Keep the original cause and
// phase visible instead of treating every rollback as a browser lock.
public sealed class SetupFailure(string phase, string recovery, Exception cause)
    : IOException(SetupErrors.Describe(cause, phase) + "\n\n" + recovery, cause) { }

public static class SetupErrors
{
    public static string Code(Exception error) => error.GetType().Name + "/" + error.HResult.ToString("X8");
    public static string Describe(Exception error, string phase)
    {
        if (error is SetupFailure) return error.Message;
        string reason;
        if (error.HResult is unchecked((int)0x80070020) or unchecked((int)0x80070021))
            reason = "文件被占用，暂时不能替换。可先在 Edge 扩展管理页关闭共享版的开关，再重试；若仍失败，请保存工作后完全退出 Edge／Chrome，或重启 Windows 后先安装。仅关闭相关标签页可能不会释放文件。";
        else if (error is UnauthorizedAccessException || error.HResult == unchecked((int)0x80070005))
            reason = "Windows 拒绝访问安装目录或浏览器连接配置。可能是目录权限、文件占用或管理策略；不能仅凭此错误确定原因。请使用原 Windows 账号直接运行，不要改用管理员身份；保留下面的诊断代码。";
        else if (error is JsonException or KeyNotFoundException or InvalidOperationException)
            reason = "安装包或已有安装记录无法读取。请重新解压完整安装包；若仍失败，请保留旧目录和恢复信息，并反馈诊断代码。";
        else if (error is IOException)
            reason = error.Message;
        else
            reason = "安装程序遇到未预期的系统错误。请反馈下面的诊断代码；不必根据此提示反复关闭浏览器。";
        return "失败步骤：" + phase + "\n" + reason + "\n诊断代码：" + Code(error);
    }
}
