let transportPartage = null;

const makeTransport = (cfg) => {

  if (transportPartage) {
    return transportPartage;
  }

  const nodemailer =
    require("nodemailer");

  transportPartage =
    nodemailer.createTransport({

      host: cfg.host,

      port:
        cfg.port || 465,

      secure:
        cfg.tls !== false,

      auth: {
        user: cfg.username,
        pass: cfg.password
      },

      tls:
        cfg.allow_self_signed
          ? {
              rejectUnauthorized: false
            }
          : undefined,

      pool:
        true,

      maxConnections:
        1,

      maxMessages:
        100,

      connectionTimeout:
        15000,

      greetingTimeout:
        15000,

      socketTimeout:
        30000
    });

  return transportPartage;
};
