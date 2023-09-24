const express = require('express');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const session = require('express-session');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const Discord = require('discord.js');
const escapeHtml = require('escape-html');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const dotenv = require('dotenv');
dotenv.config();

const botToken = process.env.TOKEN;
const client = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMembers,
        Discord.GatewayIntentBits.GuildModeration,
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.MessageContent,
    ],
});
client.login(botToken);

const app = express();
app.use(helmet());
app.disable('x-powered-by');

// Defina um limite de taxa para a rota '/auth/discord'
const authLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minuto
    max: 5, // Permitir até 5 solicitações por minuto
    message: 'Muitas tentativas de login. Por favor, tente novamente mais tarde.',
  });

// Configuração do MongoDB
mongoose.connect(process.env.MONGODB, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

const User = mongoose.model('User', {
    discordId: String,
    username: String,
    // Outros campos que você desejar
});

const Server = mongoose.model('Server', {
    server_id: String,
    custom_prefix: String,
});

// Configuração do Passport
passport.use(new DiscordStrategy({
    clientID: process.env.CLIENTID,
    clientSecret: process.env.CLIENTSECRET,
    callbackURL: process.env.CALLBACKURL,
    scope: ['identify', 'guilds'],
}, (accessToken, refreshToken, profile, done) => {
    // Aqui, você pode salvar o perfil do usuário no MongoDB ou realizar outras ações
    return done(null, profile);
}));

passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((obj, done) => {
    done(null, obj);
});

// Configuração da sessão
app.use(session({
    secret: process.env.SESSIONSECRET,
    resave: true,
    saveUninitialized: false,
}));

app.use(passport.initialize());
app.use(passport.session());

// Adicione o bodyParser para lidar com solicitações POST
app.use(bodyParser.urlencoded({ extended: true }));

// Rota de login
app.get('/auth/discord', authLimiter, passport.authenticate('discord'));

// Rota de callback após o login
app.get('/auth/discord/callback', authLimiter, passport.authenticate('discord', {
    failureRedirect: '/login-failed',
}), async (req, res) => {
    // Salvar ou atualizar o usuário no MongoDB
    const user = await User.findOne({ discordId: req.user.id });
    if (!user) {
        const newUser = new User({
            discordId: req.user.id,
            username: req.user.username,
        });
        await newUser.save();
    }

    res.redirect('/dashboard');
});

// Função para renderizar a headerbar
function renderHeaderbar(user) {
    return `
        <nav class="navbar navbar-expand-lg navbar-dark bg-dark">
            <div class="container-fluid">
                <a class="navbar-brand" href="/dashboard">Dashboard (Fase Alfa)</a>
                <div class="collapse navbar-collapse justify-content-end">
                    <ul class="navbar-nav">
                        <li class="nav-item">
                            <img src="https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png" alt="User Avatar" class="user-avatar">
                        </li>
                        <li class="nav-item">
                            <span class="navbar-text">${user.username}</span>
                        </li>
                    </ul>
                </div>
            </div>
        </nav>
    `;
}

// Rota protegida - Dashboard
app.get('/dashboard', async (req, res) => {
    // Apenas usuários autenticados têm acesso a esta rota
    if (req.isAuthenticated()) {
        const user = req.user;

        // Usar a biblioteca Discord.js para obter os servidores (guilds) do usuário
        const botAdminGuilds = await getBotAdminGuilds(user);

        const headerbar = renderHeaderbar(user);

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Dashboard</title>
                <!-- Adicione os links CSS do Bootstrap aqui -->
                <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-T3c6CoIi6uLrA9TneNEoa7RxnatzjcDSCmG1MXxSR1GAsXEV/Dwwykc2MPK8M2HN" crossorigin="anonymous">
                <link rel="stylesheet" type="text/css" href="style.css">
            </head>
            <body class="dark"> <!-- Aplicando a classe "dark" ao corpo da página -->
                ${headerbar} <!-- Headerbar -->
                <!-- Conteúdo da página -->
                <div class="container mt-4">
                    <h1 class="section-title">Painel do Usuário</h1>
                    <p>Escolha um servidor para alterar o prefixo:</p>
                    <form action="/choose-server" method="post">
                        <div class="form-group">
                            <select class="form-control" name="server">
                                ${botAdminGuilds.map(server => `<option value="${escapeHtml(server.id)}">${escapeHtml(server.name)}</option>`).join('')}
                            </select>
                        </div>
                        <button type="submit" class="btn btn-primary">Escolher</button>
                    </form>
                </div>
                <!-- Adicione os scripts do Bootstrap aqui (opcional) -->
                <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js" integrity="sha384-C6RzsynM9kWDrMNeT87bh95OGNyZPhcTNXj1NW7RuBCsyN/o0jlpcV8Qyq46cDfL" crossorigin="anonymous"></script>
            </body>
            </html>
        `);
    } else {
        res.redirect('/auth/discord');
    }
});

// Função para obter os servidores (guilds) onde o bot tem permissão de administrador
async function getBotAdminGuilds(user) {
    const botAdminGuilds = [];

    for (const guild of user.guilds) {
        const guildObject = client.guilds.cache.get(guild.id);

        if (guildObject && guildObject.members.cache.has(client.user.id) && guildObject.members.cache.get(client.user.id).permissions.has(Discord.PermissionFlagsBits.ManageGuild)) {
            botAdminGuilds.push({
                id: guild.id,
                name: guildObject.name
            });
        }
    }

    return botAdminGuilds;
}

// Rota para processar a escolha do servidor
app.post('/choose-server', (req, res) => {
    // Apenas usuários autenticados têm acesso a esta rota
    if (req.isAuthenticated()) {
        const selectedServerId = req.body.server;
        res.redirect(`/change-prefix?server=${selectedServerId}`);
    } else {
        res.redirect('/auth/discord');
    }
});

app.get('/change-prefix', async (req, res) => {
    // Apenas usuários autenticados têm acesso a esta rota
    if (req.isAuthenticated()) {
        const user = req.user;
        const serverId = req.query.server;
        const successMessage = req.query.success === 'true' ? 'Prefixo alterado com sucesso!' : '';
        if (!serverId) {
            res.redirect('/dashboard');
        }

        // Recupere o prefixo atual do servidor a partir do banco de dados
        let serverData = await Server.findOne({ server_id: serverId });

        // Se o servidor não existir no banco de dados, crie um com o prefixo padrão "$"
        if (!serverData) {
            serverData = new Server({
                server_id: serverId,
                custom_prefix: '!',
            });
            await serverData.save();
        }

        const headerbar = renderHeaderbar(user);

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Alterar Prefixo</title>
                <!-- Adicione os links CSS do Bootstrap aqui -->
                <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-T3c6CoIi6uLrA9TneNEoa7RxnatzjcDSCmG1MXxSR1GAsXEV/Dwwykc2MPK8M2HN" crossorigin="anonymous">
                <link rel="stylesheet" type="text/css" href="style.css">
            </head>
            <body class="dark"> <!-- Aplicando a classe "dark" ao corpo da página -->
                ${headerbar} <!-- Headerbar -->
                <!-- Conteúdo da página -->
                <div class="container mt-4">
                    <h1 class="section-title">Alterar Prefixo</h1>
                    <p>Username do Usuário: ${escapeHtml(user.username)}</p>
                    <p>Servidor Selecionado: ${escapeHtml(serverData.server_id)}</p>
                    <p>${successMessage}</p>
                    <form action="/save-prefix" method="post">
                        <input type="hidden" name="serverId" value="${escapeHtml(serverId)}">
                        <div class="form-group">
                            <label for="prefix">Novo Prefixo:</label>
                            <input type="text" id="prefix" name="prefix" value="${escapeHtml(serverData.custom_prefix)}" class="form-control" required>
                        </div>
                        <button type="submit" class="btn btn-primary">Alterar Prefixo</button>
                    </form>
                </div>
                <!-- Adicione os scripts do Bootstrap aqui (opcional) -->
                <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js" integrity="sha384-C6RzsynM9kWDrMNeT87bh95OGNyZPhcTNXj1NW7RuBCsyN/o0jlpcV8Qyq46cDfL" crossorigin="anonymous"></script>
            </body>
            </html>
        `);
    } else {
        res.redirect('/auth/discord');
    }
});


// Rota para salvar a alteração do prefixo
app.post('/save-prefix', async (req, res) => {
    // Apenas usuários autenticados têm acesso a esta rota
    if (req.isAuthenticated()) {
        const newPrefix = req.body.prefix;
        const serverId = req.body.serverId;

        // Atualize o prefixo no banco de dados
        await Server.updateOne({ server_id: serverId }, { $set: { custom_prefix: newPrefix } }, { upsert: true });

        // Redirecione o usuário de volta para /change-prefix com uma mensagem de sucesso
        res.redirect('/change-prefix?server=' + serverId + '&success=true');
    } else {
        res.redirect('/auth/discord');
    }
});

app.listen(3000, () => {
    console.log('Servidor rodando na porta 3000');
});
