using CoinHunter.Contracts;
using CoinHunter.Infrastructure;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Operations.Api.Services;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args.FirstOrDefault() == "maintenance" ? [] : args,
    ContentRootPath = AppContext.BaseDirectory
});
builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: false).AddEnvironmentVariables();
if (args.FirstOrDefault() == "maintenance")
{
    try { await Maintenance.Run(args.Skip(1).ToArray(), new StorageSettings(builder.Configuration)); }
    catch (Exception error) when (error is ServiceFault or IOException or InvalidOperationException or ArgumentException)
    {
        Console.Error.WriteLine(error is ServiceFault ? error.Message : "Maintenance failed. Verify arguments, storage/export integrity, and stop Operations first.");
        Environment.ExitCode = 1;
    }
    return;
}
var settings = BackendSettings.Read(builder.Configuration, builder.Environment, Protocol.OperationsService);
builder.AddBackendFoundation(settings);
builder.Services.AddSingleton<StorageSettings>();
builder.Services.AddSingleton<GameContent>();
builder.Services.AddSingleton<AlgorithmLanguages>();
builder.Services.AddSingleton<IAccountStore, FileAccountStore>();
builder.Services.AddSingleton<ISourceStore>(services => new FileSourceStore(Path.Combine(services.GetRequiredService<StorageSettings>().DataRoot, "accounts/sources")));
builder.Services.AddSingleton<IMapStore, FileMapStore>();
builder.Services.AddSingleton<AccountService>();
builder.Services.AddSingleton<SessionService>();
builder.Services.AddSingleton<IGoogleIdentityVerifier, GoogleIdentityVerifier>();
builder.Services.AddSingleton<GoogleAuthentication>();
builder.Services.AddSingleton<RequestInput>();
builder.Services.AddSingleton<StreamAdmission>();
builder.Services.AddSingleton<ExecutionClient>();
builder.Services.AddSingleton<AlgorithmValidationService>();
builder.Services.AddHostedService(services => services.GetRequiredService<AlgorithmValidationService>());
builder.Services.AddSingleton<MatchService>();
builder.Services.AddHostedService(services => services.GetRequiredService<MatchService>());
builder.Services.AddHttpClient("execution", client => client.Timeout = TimeSpan.FromSeconds(40)).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, UseProxy = false, MaxConnectionsPerServer = 32 });
builder.Services.AddHttpClient("execution-candidate-validation",client=>client.Timeout=TimeSpan.FromSeconds(120)).ConfigurePrimaryHttpMessageHandler(()=>new SocketsHttpHandler{AllowAutoRedirect=false,UseCookies=false,UseProxy=false,MaxConnectionsPerServer=2});
// Idle SSE subscribers must not occupy the pool used by start/stop/validation requests.
builder.Services.AddHttpClient("execution-updates", client => client.Timeout = TimeSpan.FromSeconds(15)).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, UseProxy = false, MaxConnectionsPerServer = 32 });
builder.Services.AddHttpClient("google", client => client.Timeout = TimeSpan.FromSeconds(10)).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false });
builder.Services.AddHttpClient<IReadinessProbe, ExecutionDependencyProbe>(client =>
{
    client.Timeout = TimeSpan.FromSeconds(1);
}).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
{
    AllowAutoRedirect = false,
    UseCookies = false,
    UseProxy = false,
    ConnectTimeout = TimeSpan.FromMilliseconds(500),
    MaxConnectionsPerServer = 8,
    PooledConnectionLifetime = TimeSpan.FromMinutes(1)
});
var app = builder.Build();
_ = app.Services.GetRequiredService<GoogleAuthentication>();
app.UseBackendFoundation(settings);
await app.RunAsync();
