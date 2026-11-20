using System.Text.Json.Nodes;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Storage;
using Microsoft.Extensions.Configuration;

namespace CoinHunter.Infrastructure;

// Trusted server configuration only. A stored validation receipt never enables a language.
public sealed class AlgorithmLanguages(IConfiguration configuration)
{
    public const string CSharpPolicy = "csharp-windows-beta-v1";
    public const string CSharpProfile = "csharp-restricted-c1-v4";
    public bool CSharpRequested => configuration.GetValue("Backend:Languages:CSharpBetaEnabled", false);
    public bool CSharpEnabled => CSharpRequested && OperatingSystem.IsWindows();
    public void Require(string language, bool authenticated)
    {
        if (language == "javascript") return;
        if (language != "csharp") throw new ServiceFault(400, "지원하지 않는 알고리즘 언어입니다.");
        if (!authenticated) throw new ServiceFault(401, "C# 베타는 로그인 후 사용할 수 있습니다.");
        if (!CSharpEnabled) throw new ServiceFault(503, "C# 베타 지원이 활성화되지 않았습니다.");
    }
    public JsonObject Describe(bool? executionReady = null) => new()
    {
        ["contractVersion"] = 1,
        ["languages"] = new JsonArray
        {
            new JsonObject { ["id"] = "javascript", ["name"] = "JavaScript", ["extension"] = ".js", ["enabled"] = true, ["requiresLogin"] = false, ["status"] = "supported", ["profile"] = "javascript-preflight-v2" },
            new JsonObject { ["id"] = "csharp", ["name"] = "C#", ["extension"] = ".cs", ["enabled"] = CSharpEnabled && executionReady != false, ["requiresLogin"] = true, ["status"] = "beta", ["profile"] = CSharpProfile, ["validationProfile"] = CSharpArtifactPreflight.Profile, ["policy"] = CSharpPolicy,
                ["reason"] = CSharpRequested && !OperatingSystem.IsWindows() ? "C# 베타는 Windows 실행 환경에서만 지원합니다." : !CSharpEnabled ? "C# 베타는 아직 활성화되지 않았습니다." : executionReady == false ? "C# 실행 서비스가 준비되지 않았습니다." : "로그인 사용자 대상 Windows 베타" }
        }
    };
}
