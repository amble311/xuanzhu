#!/usr/bin/env python3
"""统一日志模块 — 分级输出 + 文件落盘。

用法:
    from core.logger import get_logger
    log = get_logger("executor")
    log.info("下单成功")
    log.warning("接近强平价")
    log.error("连接超时")
"""
from __future__ import annotations
import os
import logging
from logging.handlers import RotatingFileHandler

LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "logs")
LOG_FMT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
DATE_FMT = "%Y-%m-%d %H:%M:%S"
_INITIALIZED = {}


def get_logger(name: str = "btc", level: int = logging.INFO,
               log_file: str | None = None) -> logging.Logger:
    """获取命名 logger，自动配置控制台 + 文件输出。

    Args:
        name: logger 名称（模块名）
        level: 日志级别
        log_file: 指定日志文件名（默认按 name 落盘到 logs/<name>.log）
    """
    if name in _INITIALIZED:
        # 重复获取时允许更新日志级别 (原实现直接返回, 传入的 level 被静默忽略)
        _INITIALIZED[name].setLevel(level)
        return _INITIALIZED[name]

    logger = logging.getLogger(name)
    logger.setLevel(level)
    logger.propagate = False  # 避免重复输出

    if not logger.handlers:
        formatter = logging.Formatter(LOG_FMT, DATE_FMT)
        # 控制台
        sh = logging.StreamHandler()
        sh.setFormatter(formatter)
        logger.addHandler(sh)
        # 文件
        os.makedirs(LOG_DIR, exist_ok=True)
        fname = log_file or f"{name}.log"
        fh = RotatingFileHandler(
            os.path.join(LOG_DIR, fname),
            maxBytes=5 * 1024 * 1024,  # 5MB
            backupCount=5,
            encoding="utf-8",
        )
        fh.setFormatter(formatter)
        logger.addHandler(fh)

    _INITIALIZED[name] = logger
    return logger


if __name__ == "__main__":
    log = get_logger("test")
    log.debug("调试信息")
    log.info("常规信息")
    log.warning("警告")
    log.error("错误")
    print(f"日志目录: {LOG_DIR}")
