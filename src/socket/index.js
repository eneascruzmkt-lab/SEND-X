function setup(io) {
  io.on('connection', (socket) => {
    socket.on('join_par', (parId) => {
      socket.join(`par_${parId}`);
    });

    socket.on('leave_par', (parId) => {
      socket.leave(`par_${parId}`);
    });
  });
}

module.exports = { setup };
