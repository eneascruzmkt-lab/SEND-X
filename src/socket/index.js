function setup(io) {
  io.on('connection', (socket) => {
    socket.on('join_par', (parId) => {
      if (parId && !isNaN(parId)) {
        socket.join(`par_${parId}`);
      }
    });

    socket.on('leave_par', (parId) => {
      if (parId && !isNaN(parId)) {
        socket.leave(`par_${parId}`);
      }
    });
  });
}

module.exports = { setup };
