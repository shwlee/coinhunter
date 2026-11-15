using CoinHunter.Contracts;
using CoinHunter.Infrastructure;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Execution.Host.Services;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory
});
builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: false).AddEnvironmentVariables();
var settings = BackendSettings.Read(builder.Configuration, builder.Environment, Protocol.ExecutionService);
builder.AddBackendFoundation(settings);
builder.Services.AddSingleton<StorageSettings>();
builder.Services.AddSingleton<GameContent>();
builder.Services.AddSingleton<ExecutionManager>();
builder.Services.AddHostedService(services => services.GetRequiredService<ExecutionManager>());
builder.Services.AddSingleton<IReadinessProbe, ExecutionBootstrapProbe>();
var app = builder.Build();
app.UseBackendFoundation(settings);
await app.RunAsync();
