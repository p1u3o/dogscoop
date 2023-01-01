var Express = require('express')
var Server = Express()
var Url = require('url');
var Exec = require("child_process")
var Colours = require('colors');
var Readline = require('readline');
var Prompt = require('prompt');
var SimpleGit = require('simple-git');
var Util = require('util');
var Fs = require('fs');
var DayJs = require('dayjs')

var Config = require('./config');
var ServerState = { Running: false, Stopping: false, Pid: null, AcceptingPlayers: false, StartTime: null, Interval: false, Process: null, LastPing: null};
var FileOutput = null;
var RestartHeld = false;

ProcessRequest = (Request, Response) =>
{
    var URL = Url.parse(Request.url, true);
	var Query = URL.query;

    if (Query['password'] === Config.Password)
    {
        let Function = URL.pathname;

        if (Function == "/start")
        {
            if (! ServerState.Running)
            {
                if (StartServer())
                {
                    Response.send(JSON.stringify({"status": "success", "reason": "started"}));
                }
                else
                {
                    Response.send(JSON.stringify({"status": "error", "reason": "failed to start"}));
                }
            }
        }
        else if (Function == "/stop")
        {
            if (ServerState.Running)
            {
                if (StopServer())
                {
                    Response.send(JSON.stringify({"status": "success", "reason": "stopped"}));
                }
                else
                {
                    Response.send(JSON.stringify({"status": "error", "reason": "failed to stop"}));
                }
            }

            return;
        }
        else if (Function == "/restart")
        {
            if (ServerState.Running)
            {
                if (RestartHeld)
                {
                    RestartHeld = false;
                    StopServer();
                }
                else
                {
                    RestartServer();
                }
            }
        }
        else if (Function == "/ping")
        {
            if (ServerState.Running)
            {
                WriteLog("info", "Pong!");

                ServerState.LastPing = new Date().getTime();
            }
        }
        else if (Function == "/started")
        {
            if (ServerState.Running)
            {
                let Uptime = (Math.floor(new Date().getTime() / 1000)  - (ServerState.StartTime / 1000)).toFixed(2)

                ServerState.AcceptingPlayers = true;
                WriteLog("success", "Server online: Startup took " + Uptime.toString() + "s");

                if (! Config.RedirOutput)
                {
                    WriteLog("info", "Switching to FXServer prompt");
                }
            }
        }
        else
        {
            Response.statusCode = 404;
            Response.send(JSON.stringify({"status": "error", "reason": "not found"}));

            return;
        }

        Response.statusCode = 200;
        Response.send(JSON.stringify({"status": "success", "reason": "done"}));
    }
    else
    {
        Response.statusCode = 401;
        Response.send(JSON.stringify({"status": "error", "reason": "unauthorized"}));
    }
}

StartServer = () =>
{
    if (! ServerState.Running && ServerState.Pid != null)
    {
        WriteLog("warn", "Found dead server");
        ServerState.Process.kill();
        ServerState.Process = null;
        ServerState.Pid = null;
        CleanUp();
    }

    if (! ServerState.Running)
    {
        ServerState.Running = true;

        WriteLog("success", "Starting Server")

        let CustomArgs = Config.CmdLine.split(" ");
    
        ServerState.Process = Exec.spawn(Config.BinPath, ["+exec", Config.ServerCfg, ...CustomArgs], { cwd: Config.DataDirectory });
    
        ServerState.Pid = ServerState.Process.pid;
    
        ServerState.Process.stdout.setEncoding('utf8');
        ServerState.StartTime = new Date().getTime();
        FileOutput = Fs.createWriteStream(__dirname + '/logs/' + DayJs().format("YYMMDD-HH-mm") + ".log", {flags : 'w+'});

        Readline.createInterface(
        {
            input     : ServerState.Process.stdout,
            terminal  : false
        })
        .on('line', function(line) 
        {
            if (Config.RedirOutput || ServerState.AcceptingPlayers)
            {
                console.log(line);
            }

            FileOutput.write(Util.format(line) + '\n');

            if (! ServerState.AcceptingPlayers)
            {
                if (line.includes("Authenticating server license key"))
                {
                    if (ServerState.Pid != null)
                    {
                        WriteLog("success", "Server runnings PID: " + ServerState.Pid);
                    }
                }
            }
        });
    
        ServerState.Process.stderr.on('data', (data) => 
        {
            WriteLog("error", `stderr: ${data}\n`);
        });
          
        ServerState.Process.on('close', (code) => 
        {
            if (ServerState.Stopping)
            {
                WriteLog("error", `Server process exited with code ${code}`);
            }
            else
            {
                WriteLog("error", `Server process exited with code ${code}`);
            }

            ServerState.Process = null;
            ServerState.Pid = null;
            ServerState.Stopping = false;
        });

        return true;
    }
    else
    {
        WriteLog("error", "Server already started");

        return false;
    }
};

PreStartup = async (Done) =>
{
    for(const Cmd of Config.PreCommands) 
    {
        try
        {
            let Run = Util.promisify(Exec.exec);
            let Result = await Run(Cmd);
    
        }
        catch(Exception)
        {
            if (Exception.code != 0)
            {
                WriteLog("info", Cmd)
                WriteLog("error", Exception.stderr.toString().trim())
            }
        }
    }

    for(const Repo of Config.Repos) 
    {
        WriteLog("info", "Syncing Repo: " + Repo)

        const Git = SimpleGit(Config.DataDirectory + "\\" + Repo, { binary: 'git' });

        let Branch = await Git.branch();

        if (! Branch.detached)
        {
            await Git.fetch();
            await Git.pull();
    
            WriteLog("success", "Synced Repo: " + Repo)
        }
        else
        {
            WriteLog("error", "Skipped Repo: " + Repo)
        }
    }

    Done();
};

StopServer = (Done) =>
{
    if (ServerState.Running)
    {
        WriteLog("error", "Stopping server")

        ServerState.Stopping = true;
        ServerState.Running = false;
        ServerState.AcceptingPlayers = false;
        ServerState.LastPing = 0;

        if (ServerState.Process != null)
        {
            ServerState.Process.stdin.end();
        }

        setTimeout(() => 
        {
            if (ServerState.Stopping)
            {
                /* Server didn't stop, so kill */   
                if (ServerState.Process != null)
                {
                    WriteLog("error", "Killing server")

                    ServerState.Process.kill();
                    ServerState.Process = null;
                    ServerState.Pid = null;
                    ServerState.Stopping = false;
                }
            }

            CleanUp();

            if (ServerState.Process == null)
            {
                WriteLog("error", "Server stopped");
                ServerState.Stopping = false;

                if (Done != undefined)
                {
                    Done();
                }
            }
        }, Config.WatchTime * 1000);
    }
    else
    {
        WriteLog("error", "Server not running")
    }
}

Tick = () =>
{
    let Uptime = (Math.floor(new Date().getTime() / 1000)  - (ServerState.StartTime / 1000)).toFixed(2)

    if (ServerState.Running && !ServerState.Stopping)
    {
        if (!ServerState.AcceptingPlayers)
        {
            WriteLog("warn", "Waiting (" + Uptime.toString() + "s)");

            if (Uptime > Config.GracePeriod)
            {
                /* Server failed to start */
                WriteLog("error", "Found dead server");
                StopServer(StartServer);
            }
        }
        else
        {
            if (ServerState.LastPing != null)
            {
                let LastPingTime = (Math.floor(new Date().getTime() / 1000)  - (ServerState.LastPing / 1000)).toFixed(2)

                if (LastPingTime > Config.GracePeriod * 2)
                {
                    WriteLog("error", "Server hasn't pinged, presume crashed");

                    StopServer(StartServer);
                }
            }
        }

        if (ServerState.Running && ServerState.Pid == null)
        {
            WriteLog("warn", "Found crashed server");

            StopServer(StartServer);
        }
    }
};

RestartServer = () => 
{
    WriteLog("info", "Restart")

    StopServer(() => 
    {
        PreStartup(StartServer)
    });
}

WriteLog = (Type, Line) =>
{
    if (Type == "success")
    {
        console.log(" > " + Colours.bold(Config.Name) + ": " + Colours.green(Line))
    }
    else if (Type == "info")
    {
        console.log(" > " + Colours.bold(Config.Name) + ": " + Colours.blue(Line))
    }
    else if (Type == "error")
    {
        console.log(" > " + Colours.bold(Config.Name) + ": " + Colours.red(Line))
    }
    else 
    {
        console.log(" > " + Colours.bold(Config.Name) + ": " + Colours.yellow(Line))
    }
};

SendCommand = (Command) =>
{
    if (ServerState.Process != null)
    {
      ServerState.Process.stdin.setEncoding('utf-8');
      ServerState.Process.stdin.write(Command + "\n");
    }
}

CleanUp = () =>
{
    ServerState.AcceptingPlayers = false;
    ServerState.LastPing = null;
    ServerState.StartTime = null;
    RestartHeld = false;
}

Server.get("/*", ProcessRequest);

Server.listen(Config.Port, Config.Host, () => 
{
    console.log("Listening on " + Config.Host + ":" + Config.Port);
    ServerState.Interval = setInterval(Tick, Config.WatchTime * 1000)

    if (Config.AutoStart)
    {
        PreStartup(StartServer)
    }

    var Input = Readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    var ReadCommands = function () 
    {
        Input.question('', function (message) 
        {
          if (message == 'exit') return Input.close();
          if (message == 'scoop start') StartServer();
          else if (message == 'scoop stop')
          {
            if (ServerState.AcceptingPlayers)
            {
                WriteLog("warn", "Graceful Shutdown");
                RestartHeld = true;
                SendCommand("startrestart 3");
            }
            else
            {
                StopServer();
                Cleanup();
            }
          }
          else if (message == 'scoop halt') StopServer();
          else if (message == 'scoop restart') RestartServer();
          else if (message == 'scoop hold') 
          {
            if (!RestartHeld)
            {
                RestartHeld = true;
                WriteLog("warn", "Next restart will keep server down, use 'scoop start' to start");
            }
            else
            {
                RestartHeld = false;
                WriteLog("warn", "Next restart will continue");
            }
          }
          else if (ServerState.Process != null)
          {
            SendCommand(message)
          }

          ReadCommands();
        });
    };
  
    ReadCommands();
});